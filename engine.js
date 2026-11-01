/**
 * dsh-port-doctor 诊断内核。
 *
 * 与 DSH / cordis 解耦：只依赖 node 标准库，插件（index.js）和独立 CLI
 * （cli.js）共用同一份判定逻辑，避免两套实现漂移。
 *
 * 判定分四步，缺一不可：
 *   1. 绑定探测 —— 真正 listen 一次，确认「dsh 能不能起来」（比 grep netstat 更接近真相）；
 *   2. 监听者枚举 —— netstat/lsof 找到 LISTENING 的 PID（可能多个，含 IPv4/IPv6）；
 *   3. 进程身份 —— 进程名 + 完整命令行 + 父进程 + 启动时间（判断「谁」而不是「有个进程」）；
 *   4. HTTP 指纹 —— 探测 HTTP 响应，确认它到底是不是 DSH（DSH 的 401 文案是稳定指纹）。
 *
 * @module dsh-port-doctor/engine
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';

/** 未指定端口时的默认值：DSH Web 的默认端口。 */
export const DEFAULT_PORT = 3080;

/** 未指定地址时的默认值：DSH Web 默认只绑回环。 */
export const DEFAULT_HOST = '127.0.0.1';

/** 扫描可用端口时向上试探的窗口大小。 */
const SCAN_WINDOW = 20;

/** 建议里最多列出的备用端口数量。 */
const MAX_SUGGESTIONS = 3;

/** HTTP 探测最多读取的响应字节数（够拿到 <title> 与 DSH 指纹）。 */
const HTTP_BODY_LIMIT = 64 * 1024;

/** DSH Web 未带鉴权令牌时的稳定响应文案，用作强指纹。 */
const DSH_AUTH_MARKER = 'dsh web authentication required';

/**
 * 跑一条外部命令，永不抛错：失败也返回结构化结果，让诊断继续降级。
 * @param {string} command - 可执行文件名（不含 shell）。
 * @param {readonly string[]} args - 参数数组，绝不拼接成 shell 字符串。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @param {number} [timeoutMs] - 单条命令超时。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: string | number | undefined}>} 执行结果。
 */
function run(command, args, signal, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20, encoding: 'utf8', signal },
      (error, stdout, stderr) => {
        // execFile 成功时回调里的 error 是 null（不是 undefined），只能用 == null 判断。
        resolve({
          ok: error == null,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code: error?.code,
        });
      },
    );
  });
}

/**
 * 若调用方已取消，立刻以 AbortError 结束，避免把取消当成「端口空闲」这类假结论。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @throws {Error} 已取消时抛出 AbortError。
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('port_doctor: aborted');
}

/**
 * 归一化监听地址：去掉 IPv6 方括号，保留 `::`/`0.0.0.0` 的语义。
 * @param {string} address - netstat/lsof 给出的本地地址片段。
 * @returns {string} 归一化后的地址。
 */
export function normalizeAddress(address) {
  const trimmed = address.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * 解析 Windows `netstat -ano -p TCP` 的输出，只保留目标端口上的 LISTENING 行。
 * 不依赖任何语言环境：状态列按 LISTEN 前缀匹配，非监听状态一律跳过。
 * @param {string} text - netstat 原始输出。
 * @param {number} port - 目标端口。
 * @returns {{address: string, pid: number}[]} 去重后的监听者列表。
 */
export function parseNetstat(text, port) {
  const found = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const [proto, local, , state, pidText] = parts;
    if (!/^TCP/i.test(proto)) continue;
    if (!/^LISTEN/i.test(state)) continue;
    const match = /^(.*):(\d+)$/.exec(local);
    if (match === null) continue;
    if (Number(match[2]) !== port) continue;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    found.set(`${normalizeAddress(match[1])}|${pid}`, { address: normalizeAddress(match[1]), pid });
  }
  return [...found.values()];
}

/**
 * 解析 `lsof -Fpcn` 的字段流（POSIX 回退路径）。
 * @param {string} text - lsof 原始输出。
 * @param {number} port - 目标端口。
 * @returns {{address: string, pid: number}[]} 去重后的监听者列表。
 */
export function parseLsof(text, port) {
  const found = new Map();
  let pid = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } else if (tag === 'n' && pid > 0) {
      const match = /^(.*):(\d+)$/.exec(value);
      if (match === null || Number(match[2]) !== port) continue;
      const address = normalizeAddress(match[1]);
      found.set(`${address}|${pid}`, { address, pid });
    }
  }
  return [...found.values()];
}

/**
 * 枚举某端口上的监听者（Windows 用 netstat，其余用 lsof）。
 * @param {number} port - 目标端口。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{listeners: {address: string, pid: number}[], error: string}>} 监听者与枚举失败原因。
 */
export async function findListeners(port, signal) {
  throwIfAborted(signal);
  if (process.platform === 'win32') {
    const result = await run('netstat', ['-ano', '-p', 'TCP'], signal);
    if (!result.ok) return { listeners: [], error: `netstat 执行失败（${result.code ?? 'unknown'}）` };
    return { listeners: parseNetstat(result.stdout, port), error: '' };
  }
  const result = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], signal);
  // lsof 在没有任何匹配时以 1 退出，这不是错误。
  if (!result.ok && result.stdout.trim() === '') return { listeners: [], error: result.code === 1 ? '' : 'lsof 不可用（可忽略）' };
  return { listeners: parseLsof(result.stdout, port), error: '' };
}

/**
 * 真正绑定一次再释放，回答「dsh 现在能不能起来」。
 * @param {string} host - 绑定地址。
 * @param {number} port - 绑定端口。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{bindable: boolean, code: string, message: string}>} 绑定结果。
 */
export function probeBind(host, port, signal) {
  return new Promise((resolve) => {
    throwIfAborted(signal);
    const server = createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // 未监听时 close 也会抛，忽略即可。
      }
      resolve(value);
    };
    server.once('error', (error) => finish({ bindable: false, code: String(error.code ?? ''), message: String(error.message ?? '') }));
    server.once('listening', () => finish({ bindable: true, code: '', message: '' }));
    try {
      server.listen({ port, host, exclusive: true });
    } catch (error) {
      finish({ bindable: false, code: String(error.code ?? ''), message: String(error.message ?? '') });
    }
  });
}

/**
 * Windows：一次性取进程名、完整命令行、父进程、启动时间（CIM，wmic 已被 Win11 移除）。
 * @param {number} pid - 目标 PID。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{name: string, commandLine: string, parentPid: number, startedAt: string}>} 进程信息。
 */
async function windowsProcessInfo(pid, signal) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';`,
    'if($p){[pscustomobject]@{Name=[string]$p.Name;CommandLine=[string]$p.CommandLine;',
    "ParentProcessId=[int]$p.ParentProcessId;CreationDate=[string]$p.CreationDate.ToString('o')}|ConvertTo-Json -Compress}",
  ].join('');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], signal);
  let info = { name: '', commandLine: '', parentPid: 0, startedAt: '' };
  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      info = {
        name: String(parsed.Name ?? '').trim(),
        commandLine: String(parsed.CommandLine ?? '').trim(),
        parentPid: Number.isInteger(parsed.ParentProcessId) ? parsed.ParentProcessId : 0,
        startedAt: String(parsed.CreationDate ?? '').trim(),
      };
    } catch {
      // 落到 tasklist 回退。
    }
  }
  if (info.name === '') {
    const tasklist = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], signal);
    const match = /^"([^"]*)"/.exec(tasklist.stdout.trim());
    if (match !== null) info.name = match[1];
  }
  return info;
}

/**
 * POSIX：优先读 /proc/<pid>，否则用 ps。
 * @param {number} pid - 目标 PID。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{name: string, commandLine: string, parentPid: number, startedAt: string}>} 进程信息。
 */
async function posixProcessInfo(pid, signal) {
  const info = { name: '', commandLine: '', parentPid: 0, startedAt: '' };
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    info.commandLine = raw.split('\u0000').filter((part) => part !== '').join(' ').trim();
  } catch {
    // 没有 /proc（macOS）时走 ps。
  }
  const ps = await run('ps', ['-p', String(pid), '-o', 'ppid=,lstart=,comm='], signal);
  const line = ps.stdout.trim();
  if (line !== '') {
    const match = /^(\d+)\s+(.+?)\s{2,}(\S+)$/.exec(line);
    if (match !== null) {
      info.parentPid = Number(match[1]);
      info.startedAt = match[2].trim();
      if (info.name === '') info.name = match[3];
    }
  }
  if (info.commandLine === '') {
    const args = await run('ps', ['-p', String(pid), '-o', 'args='], signal);
    info.commandLine = args.stdout.trim();
  }
  return info;
}

/**
 * 取单个进程的身份信息，任何一步失败都只降级、不抛错。
 * @param {number} pid - 目标 PID。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{name: string, commandLine: string, parentPid: number, startedAt: string}>} 进程信息。
 */
export async function processInfo(pid, signal) {
  throwIfAborted(signal);
  if (pid <= 0) return { name: '', commandLine: '', parentPid: 0, startedAt: '' };
  const info = process.platform === 'win32'
    ? await windowsProcessInfo(pid, signal)
    : await posixProcessInfo(pid, signal);
  throwIfAborted(signal);
  return info;
}

/**
 * 判断命令行是否指向一个 dsh 进程（不依赖进程名：npx 下进程名可能不是 node）。
 * @param {string} commandLine - 完整命令行。
 * @returns {boolean} 是否像 dsh。
 */
export function looksLikeDshCommand(commandLine) {
  return /(?:^|[\\/\s"'@])dsh[\\/](?:lib[\\/])?bin\.js|@deepseek-ai[\\/]dsh(?:[\\/\s"']|$)|deepseek-harness/i.test(String(commandLine));
}

/**
 * 从命令行里读出 profile 名，读不到返回空串。
 * @param {string} commandLine - 完整命令行。
 * @returns {string} profile 名或空串。
 */
export function profileFromCommandLine(commandLine) {
  const cmd = String(commandLine);
  const named = /--profile[= ]([\w.-]+)/.exec(cmd);
  if (named !== null) return named[1];
  const bare = /dsh[\\/]lib[\\/]bin\.js"?\s+([a-z][\w-]*)/i.exec(cmd);
  if (bare !== null) return bare[1];
  return '';
}

/**
 * 探测该端口上的 HTTP 服务，并判断它是不是 DSH。
 * DSH Web 未带令牌时返回 401 + 固定文案，这是比进程名更可靠的指纹。
 * @param {string} host - 目标地址。
 * @param {number} port - 目标端口。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<{reachable: boolean, statusCode: number, server: string, title: string, dshLike: boolean, detail: string}>} 探测结果。
 */
export function probeHttp(host, port, signal) {
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ reachable: false, statusCode: 0, server: '', title: '', dshLike: false, detail: '已取消' });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = request(
        {
          host: target,
          port,
          path: '/',
          method: 'GET',
          agent: false,
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'dsh-port-doctor' },
          timeout: 2500,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < HTTP_BODY_LIMIT) body += chunk;
          });
          res.on('error', () => finish(describeHttp(res.statusCode ?? 0, res.headers.server, body)));
          res.on('end', () => finish(describeHttp(res.statusCode ?? 0, res.headers.server, body)));
        },
      );
    } catch (error) {
      finish({ reachable: false, statusCode: 0, server: '', title: '', dshLike: false, detail: `HTTP 探测失败：${String(error.message ?? error)}` });
      return;
    }
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (error) => finish({
      reachable: false,
      statusCode: 0,
      server: '',
      title: '',
      dshLike: false,
      detail: `HTTP 探测无响应（${error.code ?? error.message}）——可能不是 HTTP 服务，或只接受 TLS`,
    }));
    req.end();
  });
}

/**
 * 把一次 HTTP 响应翻译成诊断字段。
 * @param {number} statusCode - HTTP 状态码。
 * @param {string | undefined} server - Server 响应头。
 * @param {string} body - 已截断的响应体。
 * @returns {{reachable: boolean, statusCode: number, server: string, title: string, dshLike: boolean, detail: string}} 诊断字段。
 */
function describeHttp(statusCode, server, body) {
  const serverHeader = typeof server === 'string' ? server : '';
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
  const title = titleMatch === null ? '' : titleMatch[1].trim();
  const dshLike = body.includes('__DSH_BOOT__')
    || body.toLowerCase().includes(DSH_AUTH_MARKER)
    || /deepseek\s*harness/i.test(body)
    || /deepseek/i.test(serverHeader);
  let detail;
  if (statusCode === 401 && body.toLowerCase().includes(DSH_AUTH_MARKER)) {
    detail = '401：这是 DSH Web（需要 dsh 启动时打印的鉴权令牌）';
  } else if (body.includes('__DSH_BOOT__')) {
    detail = '200：返回 DSH Web 前端页面';
  } else {
    detail = `HTTP ${statusCode}` + (title !== '' ? `，标题「${title}」` : '') + (serverHeader !== '' ? `，Server: ${serverHeader}` : '');
  }
  return { reachable: true, statusCode, server: serverHeader, title, dshLike, detail };
}

/**
 * 从目标端口往上找一个能绑定的端口，给「换端口」提供具体数字。
 * @param {string} host - 绑定地址。
 * @param {number} port - 起始端口（不含）。
 * @param {AbortSignal | undefined} signal - 调用方取消信号。
 * @returns {Promise<number[]>} 最多 MAX_SUGGESTIONS 个可用端口。
 */
export async function findFreePorts(host, port, signal) {
  const free = [];
  const upper = Math.min(port + SCAN_WINDOW, 65535);
  for (let candidate = port + 1; candidate <= upper && free.length < MAX_SUGGESTIONS; candidate += 1) {
    throwIfAborted(signal);
    const probe = await probeBind(host, candidate, signal);
    if (probe.bindable) free.push(candidate);
  }
  return free;
}

/**
 * 归纳结论。优先级就是人的排查顺序：能绑定 → 自己 → 另一个 DSH → 其它 node → 其它进程。
 * @param {{bindable: boolean, listeners: {address: string, pid: number}[], pid: number, selfPid: number, looksLikeDsh: boolean, dshLike: boolean, processName: string}} input - 判定输入。
 * @returns {'free'|'self'|'other-dsh'|'other-node'|'other-process'|'unknown'} 结论。
 */
export function classifyVerdict(input) {
  if (input.bindable) return 'free';
  if (input.pid > 0 && input.pid === input.selfPid) return 'self';
  if (input.pid > 0) {
    if (input.looksLikeDsh || input.dshLike) return 'other-dsh';
    if (/^node(?:\.exe)?$/i.test(input.processName)) return 'other-node';
    return 'other-process';
  }
  return 'unknown';
}

/**
 * 生成处置建议：只给「下一步」，不替用户做杀进程的决定。
 * @param {object} result - {@link diagnose} 的返回对象。
 * @returns {string[]} 建议行。
 */
export function buildAdvice(result) {
  const port = result.port;
  const host = result.host;
  const spare = result.freePorts[0] ?? port + 1;
  const relaunch = `npx @deepseek-ai/dsh web --port ${spare}`;
  const advice = [];

  switch (result.verdict) {
    case 'free':
      advice.push(`端口 ${port} 在 ${host} 上可绑定，直接启动即可。`);
      if (result.listeners.length > 0) {
        const where = result.listeners.map((item) => `${item.address}:${port}`).join('、');
        advice.push(`注意：${where} 上另有监听进程（PID ${result.pid}），但不在 ${host} 上，不会挡住 dsh。`);
      }
      break;
    case 'self':
      advice.push(`占用者就是当前这个 DSH 实例（PID ${result.pid}${result.profile !== '' ? `，profile ${result.profile}` : ''}）——你正在和它对话。`);
      advice.push('不要杀它：杀掉会连同当前会话一起结束。要再起一个实例，就换端口。');
      advice.push(`换端口启动：${relaunch}`);
      advice.push('或者直接复用浏览器里已经打开的那个 DSH 页面。');
      break;
    case 'other-dsh':
      advice.push(`另一个 DSH 实例正占用该端口（PID ${result.pid}${result.profile !== '' ? `，profile ${result.profile}` : ''}）。`);
      advice.push('它可能是一个还开着的窗口，也可能是上次没退干净的残留——看上面的启动时间和命令行再判断。');
      advice.push(`确认那个实例不再需要：先正常退出（在那个终端按 Ctrl+C），再启动；确需强杀才执行 taskkill /PID ${result.pid} /F。`);
      advice.push(`两个都要同时跑：换端口 ${relaunch}`);
      break;
    case 'other-node':
      advice.push(`占用者是另一个 node 进程（PID ${result.pid}，${result.processName}），不是 DSH。`);
      advice.push('不要直接杀它，它可能是你另一个项目在跑的服务。');
      advice.push(`直接换端口：${relaunch}`);
      break;
    case 'other-process':
      advice.push(`占用者是 ${result.processName !== '' ? result.processName : '一个非 node 进程'}（PID ${result.pid}），看起来不是 DSH。`);
      advice.push(`换端口启动是更安全的选择：${relaunch}`);
      advice.push('若确认该进程可以停，再自行结束它；port_doctor 不会替你杀进程。');
      break;
    default:
      advice.push(`端口 ${port} 被占用，但拿不到占用者的 PID（可能是权限不足或系统级保留）。`);
      advice.push(`换端口启动：${relaunch}`);
      advice.push(`排查命令：netstat -ano | findstr :${port}`);
      break;
  }

  if (result.freePorts.length > 0) advice.push(`当前可用端口：${result.freePorts.join('、')}。`);
  return advice;
}

/**
 * 诊断一个端口的完整流程。
 * @param {{port?: number, host?: string, selfPid?: number, selfPort?: number, scan?: boolean}} [options] - 诊断参数。
 * @param {AbortSignal} [signal] - 调用方取消信号。
 * @returns {Promise<object>} 结构化诊断结果（字段与插件输出 schema 一一对应）。
 */
export async function diagnose(options = {}, signal) {
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : DEFAULT_HOST;
  const selfPid = Number.isInteger(options.selfPid) && options.selfPid > 0 ? options.selfPid : process.pid;
  const selfPort = Number.isInteger(options.selfPort) && options.selfPort > 0 ? options.selfPort : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port_doctor: 端口必须是 1-65535 的整数，收到 ${String(port)}`);

  throwIfAborted(signal);
  const bind = await probeBind(host, port, signal);
  const enumerated = await findListeners(port, signal);
  const listeners = enumerated.listeners;
  const pid = listeners.length > 0 ? listeners[0].pid : 0;
  const info = await processInfo(pid, signal);
  const http = bind.bindable
    ? { reachable: false, statusCode: 0, server: '', title: '', dshLike: false, detail: '端口可绑定，未做 HTTP 探测' }
    : await probeHttp(host, port, signal);
  const looksLikeDsh = looksLikeDshCommand(info.commandLine);
  const verdict = classifyVerdict({
    bindable: bind.bindable,
    listeners,
    pid,
    selfPid,
    looksLikeDsh,
    dshLike: http.dshLike,
    processName: info.name,
  });
  const freePorts = bind.bindable || options.scan === false ? [] : await findFreePorts(host, port, signal);
  const profile = profileFromCommandLine(info.commandLine);

  const result = {
    port,
    host,
    selfPort,
    status: bind.bindable ? 'free' : 'occupied',
    verdict,
    bindable: bind.bindable,
    bindError: bind.bindable ? '' : `${bind.code !== '' ? bind.code : 'EBUSY'}${bind.message !== '' ? '：' + bind.message : ''}`,
    ownerKnown: pid > 0,
    pid,
    processName: info.name,
    commandLine: info.commandLine,
    parentPid: info.parentPid,
    startedAt: info.startedAt,
    profile,
    looksLikeDsh,
    listeners: listeners.map((item) => ({ address: item.address, pid: item.pid })),
    httpReachable: http.reachable,
    httpStatus: http.statusCode,
    httpServer: http.server,
    httpDshLike: http.dshLike,
    httpDetail: http.detail,
    listenerError: enumerated.error,
    freePorts,
    advice: [],
    summary: '',
  };

  result.advice = buildAdvice(result);
  result.summary = summarize(result);
  return result;
}

/**
 * 一行结论。
 * @param {object} result - {@link diagnose} 的返回对象。
 * @returns {string} 摘要。
 */
export function summarize(result) {
  const where = `端口 ${result.port}`;
  switch (result.verdict) {
    case 'free':
      return `${where}（${result.host}）空闲，可正常启动。`;
    case 'self':
      return `${where} 被当前 DSH 实例（PID ${result.pid}）占用——就是你正在用的这个进程。`;
    case 'other-dsh':
      return `${where} 被另一个 DSH 实例（PID ${result.pid}）占用。`;
    case 'other-node':
      return `${where} 被另一个 node 进程（PID ${result.pid}）占用。`;
    case 'other-process':
      return `${where} 被 ${result.processName !== '' ? result.processName : '其它进程'}（PID ${result.pid}）占用。`;
    default:
      return `${where} 被占用，但无法确定占用进程。`;
  }
}

/**
 * 把结构化结果渲染成人类可读的多行文本（CLI 与工具输出共用）。
 * @param {object} result - {@link diagnose} 的返回对象。
 * @returns {string} 报告文本。
 */
export function formatReport(result) {
  const lines = [];
  lines.push(`[${result.verdict}] ${result.summary}`);
  if (result.ownerKnown) {
    lines.push(`  进程    ${result.processName !== '' ? result.processName : '(未知)'}  PID ${result.pid}${result.parentPid > 0 ? `  父进程 ${result.parentPid}` : ''}`);
    if (result.startedAt !== '') lines.push(`  启动于  ${result.startedAt}`);
    if (result.profile !== '') lines.push(`  profile ${result.profile}`);
    if (result.commandLine !== '') lines.push(`  命令行  ${result.commandLine}`);
  } else if (result.status === 'occupied') {
    lines.push('  进程    (拿不到 PID)');
  }
  if (result.listeners.length > 0) {
    lines.push(`  监听    ${result.listeners.map((item) => `${item.address}:${result.port} (PID ${item.pid})`).join('  ')}`);
  }
  if (result.status === 'occupied') {
    lines.push(`  绑定    ${result.host}:${result.port} → 失败（${result.bindError}）`);
    lines.push(`  HTTP    ${result.httpDetail}`);
  } else if (result.httpReachable) {
    lines.push(`  HTTP    ${result.httpDetail}`);
  }
  if (result.listenerError !== '') lines.push(`  注意    ${result.listenerError}`);
  lines.push('  建议');
  for (const item of result.advice) lines.push(`    · ${item}`);
  return lines.join('\n');
}
