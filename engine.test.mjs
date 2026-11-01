/**
 * 内核测试：既覆盖纯解析逻辑，也真的在本机开/关一个端口做端到端诊断。
 * 用 node --test 跑，不依赖任何第三方测试框架。
 */

import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  buildAdvice,
  classifyVerdict,
  diagnose,
  findFreePorts,
  formatReport,
  looksLikeDshCommand,
  normalizeAddress,
  parseLsof,
  parseNetstat,
  probeBind,
  profileFromCommandLine,
} from './engine.js';

const HOST = '127.0.0.1';

/**
 * 起一个监听随机端口的服务。
 * @param {import('node:net').Server} server - 待监听的服务。
 * @returns {Promise<number>} 实际端口。
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

/**
 * 关掉服务。
 * @param {import('node:net').Server} server - 待关闭的服务。
 * @returns {Promise<void>} 关闭完成。
 */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 真实的 Windows netstat 片段（含同一 PID 的 ESTABLISHED 干扰行与 IPv6 行）。 */
const NETSTAT_SAMPLE = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       48210
  TCP    127.0.0.1:3080         127.0.0.1:1513         ESTABLISHED     48210
  TCP    127.0.0.1:3080         127.0.0.1:4335         TIME_WAIT       0
  TCP    [::]:3080              [::]:0                 LISTENING       48210
  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       999
`;

describe('解析', () => {
  test('parseNetstat 只取目标端口上的 LISTENING，并去重', () => {
    assert.deepEqual(parseNetstat(NETSTAT_SAMPLE, 3080), [
      { address: '127.0.0.1', pid: 48210 },
      { address: '::', pid: 48210 },
    ]);
    assert.deepEqual(parseNetstat(NETSTAT_SAMPLE, 3081), [{ address: '127.0.0.1', pid: 999 }]);
    assert.deepEqual(parseNetstat(NETSTAT_SAMPLE, 4000), []);
    assert.deepEqual(parseNetstat('', 3080), []);
  });

  test('parseNetstat 跳过 PID 为 0 的 TIME_WAIT 行', () => {
    const text = '  TCP    127.0.0.1:3080         127.0.0.1:4335         LISTENING       0';
    assert.deepEqual(parseNetstat(text, 3080), []);
  });

  test('parseLsof 按 p/n 字段对齐 PID 与地址', () => {
    const text = 'p4242\ncnode\nn*:3080\np5151\ncnginx\nn127.0.0.1:3080\nn[::1]:3080';
    assert.deepEqual(parseLsof(text, 3080), [
      { address: '*', pid: 4242 },
      { address: '127.0.0.1', pid: 5151 },
      { address: '::1', pid: 5151 },
    ]);
  });

  test('normalizeAddress 去掉 IPv6 方括号', () => {
    assert.equal(normalizeAddress('[::]'), '::');
    assert.equal(normalizeAddress('127.0.0.1'), '127.0.0.1');
    assert.equal(normalizeAddress(' [::1] '), '::1');
  });

  test('looksLikeDshCommand 认 npx 下的 bin.js 与 workspace 路径', () => {
    assert.equal(looksLikeDshCommand('"node" "C:\\npm-cache\\_npx\\abc\\node_modules\\.bin\\\\..\\@deepseek-ai\\dsh\\lib\\bin.js" web'), true);
    assert.equal(looksLikeDshCommand('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web'), true);
    assert.equal(looksLikeDshCommand('node E:\\web\\server.js'), false);
    assert.equal(looksLikeDshCommand(''), false);
  });

  test('profileFromCommandLine 同时支持位置参数与 --profile', () => {
    const cmd = '"node" "C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web';
    assert.equal(profileFromCommandLine(cmd), 'web');
    assert.equal(profileFromCommandLine('node dsh.js --profile desktop'), 'desktop');
    assert.equal(profileFromCommandLine('node app.js'), '');
  });
});

describe('判定', () => {
  const base = { bindable: false, listeners: [{ address: '127.0.0.1', pid: 10 }], pid: 10, selfPid: 99, looksLikeDsh: false, dshLike: false, processName: 'node.exe' };

  test('可绑定就是 free', () => {
    assert.equal(classifyVerdict({ ...base, bindable: true }), 'free');
  });
  test('自己占用优先于其它判断', () => {
    assert.equal(classifyVerdict({ ...base, pid: 99, selfPid: 99, dshLike: true, looksLikeDsh: true }), 'self');
  });
  test('命令行或 HTTP 任一命中都算另一个 DSH', () => {
    assert.equal(classifyVerdict({ ...base, looksLikeDsh: true }), 'other-dsh');
    assert.equal(classifyVerdict({ ...base, dshLike: true }), 'other-dsh');
  });
  test('其它 node 与其它进程要分开', () => {
    assert.equal(classifyVerdict({ ...base, processName: 'node.exe' }), 'other-node');
    assert.equal(classifyVerdict({ ...base, processName: 'nginx.exe' }), 'other-process');
  });
  test('没有 PID 时是 unknown', () => {
    assert.equal(classifyVerdict({ ...base, pid: 0, listeners: [] }), 'unknown');
  });
});

describe('真实端口', () => {
  /** 假装 DSH Web 的 401 服务。 @type {import('node:http').Server} */
  let dshLike;
  /** 假 DSH 的端口。 @type {number} */
  let dshPort;

  before(async () => {
    dshLike = createHttpServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.');
    });
    dshPort = await listen(dshLike);
  });

  after(async () => {
    await close(dshLike);
  });

  test('probeBind：被占用时失败，释放后成功', async () => {
    const occupied = await probeBind(HOST, dshPort);
    assert.equal(occupied.bindable, false);
    assert.equal(typeof occupied.code, 'string');

    const spare = createTcpServer();
    const freePort = await listen(spare);
    await close(spare);
    const freed = await probeBind(HOST, freePort);
    assert.equal(freed.bindable, true);
  });

  test('diagnose 识别「这是别的 DSH」并给出 PID/命令行', async () => {
    const result = await diagnose({ port: dshPort, host: HOST, selfPid: 1, scan: false });
    assert.equal(result.status, 'occupied');
    assert.equal(result.verdict, 'other-dsh');
    assert.equal(result.ownerKnown, true);
    assert.equal(result.pid, process.pid);
    assert.equal(result.httpStatus, 401);
    assert.equal(result.httpDshLike, true);
    assert.match(result.httpDetail, /DSH Web/);
    assert.ok(result.processName.length > 0, '应拿到进程名');
    assert.ok(result.advice.length > 0);
    assert.ok(result.freePorts.length === 0, 'scan=false 时不扫描');
  });

  test('diagnose 把「自己占着自己」单独判成 self，并警告不要杀', async () => {
    const result = await diagnose({ port: dshPort, host: HOST, selfPid: process.pid, scan: false });
    assert.equal(result.verdict, 'self');
    assert.match(result.advice.join('\n'), /不要杀/);
    assert.match(result.summary, /当前 DSH 实例/);
  });

  test('diagnose 对空闲端口返回 free', async () => {
    const spare = createTcpServer();
    const freePort = await listen(spare);
    await close(spare);
    const result = await diagnose({ port: freePort, host: HOST, scan: false });
    assert.equal(result.status, 'free');
    assert.equal(result.verdict, 'free');
    assert.equal(result.pid, 0);
    assert.match(result.advice[0], /可绑定/);
  });

  test('findFreePorts 返回的端口确实可绑定且不等于原端口', async () => {
    const ports = await findFreePorts(HOST, dshPort);
    assert.ok(ports.length > 0);
    for (const port of ports) {
      assert.notEqual(port, dshPort);
      const probe = await probeBind(HOST, port);
      assert.equal(probe.bindable, true, `候选端口 ${port} 应该可绑定`);
    }
  });

  test('formatReport 包含结论、进程与建议三段', () => {
    const fixture = {
      port: 3080,
      host: HOST,
      selfPort: 3080,
      status: 'occupied',
      verdict: 'self',
      bindable: false,
      bindError: 'EADDRINUSE: listen EADDRINUSE: address already in use 127.0.0.1:3080',
      ownerKnown: true,
      pid: 48210,
      processName: 'node.exe',
      commandLine: 'node dsh/bin.js web',
      parentPid: 5512,
      startedAt: '2026-11-01T11:44:51+08:00',
      profile: 'web',
      looksLikeDsh: true,
      listeners: [{ address: '127.0.0.1', pid: 48210 }],
      httpReachable: true,
      httpStatus: 401,
      httpServer: '',
      httpDshLike: true,
      httpDetail: '401：这是 DSH Web（需要鉴权令牌）',
      listenerError: '',
      freePorts: [3081, 3082],
      advice: [],
      summary: '端口 3080 被当前 DSH 实例（PID 48210）占用。',
    };
    fixture.advice = buildAdvice(fixture);
    const text = formatReport(fixture);
    assert.match(text, /\[self\]/);
    assert.match(text, /PID 48210/);
    assert.match(text, /profile web/);
    assert.match(text, /建议/);
    assert.match(text, /3081/);
  });
});
