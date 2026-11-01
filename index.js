/**
 * dsh-port-doctor —— DeepSeek Harness 插件
 *
 * 只做一件事：当 `dsh web` 报 EADDRINUSE 时，回答「谁占着这个端口、它是不是我自己、
 * 我下一步该怎么办」。注册一个面向模型的工具 `port_doctor`，把判断结果交回给用户
 * 或 agent 决定——插件自己绝不杀进程。
 *
 * 为什么不做「启动时拦截」：webserver 的 bind 失败发生在它自己的 fiber 里，boot 会
 * 直接报错退出，排在它后面的插件根本不会被挂载。所以本插件走「按需诊断」这条路，
 * 并且额外提供 cli.js，在 DSH 还没起来时也能用。
 *
 * @module dsh-port-doctor
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_HOST, DEFAULT_PORT, diagnose, formatReport } from './engine.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'port-doctor';

/** 依赖的服务：工具注册表。 */
export const inject = ['tools'];

/** 部署级默认值，可在 profile 补丁行的 config 里覆盖。 */
export const Config = z.object({
  port: z.number().default(DEFAULT_PORT),
  host: z.string().default(DEFAULT_HOST),
});

/** 结论枚举，schema 与实现共用一份。 */
const VERDICTS = ['free', 'self', 'other-dsh', 'other-node', 'other-process', 'unknown'];

/** 状态枚举。 */
const STATUSES = ['free', 'occupied'];

/**
 * 读出本进程正在服务的端口，用于把「这是你自己」和「这是另一个实例」区分开。
 * 服务名是 `webServer`（大小写敏感）；未挂载 webserver 的 profile 上返回 0。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @returns {number} 监听端口，未知时为 0。
 */
function readSelfPort(ctx) {
  for (const service of ['webServer', 'webserver']) {
    try {
      const port = ctx.get(service)?.port;
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // 服务未提供：忽略，继续用下一候选。
    }
  }
  return 0;
}

/**
 * 挂载工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {{port: number, host: string}} config - 部署配置。
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'port_doctor',
    description: [
      '诊断端口占用：说清楚谁占着端口、它是不是当前这个 DSH 实例、以及下一步该怎么办。',
      '在 dsh web 报 EADDRINUSE、或怀疑端口被上次残留的进程占住时使用。',
      '默认诊断当前 DSH 自己服务的端口（拿不到则 3080）。',
      '输出包含占用进程的 PID、进程名、完整命令行、父进程、启动时间、profile，',
      '以及 HTTP 指纹（能识别「对面是不是另一个 DSH」）和可用备用端口。',
      '本工具只读诊断，不会杀进程；要结束进程需用户确认后用 pwsh/taskkill 执行。',
    ].join(' '),
    parameters: {
      port: {
        type: 'integer',
        description: `要诊断的端口，1-65535；省略时用当前 DSH 的监听端口（${DEFAULT_PORT} 兜底）。`,
      },
      host: {
        type: 'string',
        description: `要检查的绑定地址，默认 ${DEFAULT_HOST}。`,
      },
      scan: {
        type: 'boolean',
        description: '端口被占用时，是否继续向上扫描可用端口（默认 true）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          port: { type: 'integer', required: true, description: '被诊断的端口。' },
          host: { type: 'string', required: true, description: '检查的绑定地址。' },
          selfPort: { type: 'integer', required: true, description: '当前 DSH 实例正在服务的端口，0 表示未知。' },
          status: { type: 'string', required: true, enum: [...STATUSES], description: 'free=该地址可绑定，occupied=不可绑定。' },
          verdict: { type: 'string', required: true, enum: [...VERDICTS], description: '结论：free/self/other-dsh/other-node/other-process/unknown。' },
          bindable: { type: 'boolean', required: true, description: '真实 listen 一次是否成功。' },
          bindError: { type: 'string', required: true, description: '绑定失败的错误码与消息。' },
          ownerKnown: { type: 'boolean', required: true, description: '是否拿到了占用者 PID。' },
          pid: { type: 'integer', required: true, description: '占用进程 PID，0 表示未知。' },
          processName: { type: 'string', required: true, description: '占用进程的映像名，如 node.exe。' },
          commandLine: { type: 'string', required: true, description: '占用进程的完整命令行。' },
          parentPid: { type: 'integer', required: true, description: '父进程 PID，0 表示未知。' },
          startedAt: { type: 'string', required: true, description: '进程启动时间（本机时区字符串）。' },
          profile: { type: 'string', required: true, description: '从命令行解析出的 dsh profile 名，空串表示未识别。' },
          looksLikeDsh: { type: 'boolean', required: true, description: '命令行是否指向 dsh。' },
          listeners: {
            type: 'array',
            required: true,
            description: '该端口上的监听者（可能同时有 IPv4/IPv6 多条）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                address: { type: 'string', required: true, description: '本地监听地址。' },
                pid: { type: 'integer', required: true, description: '监听进程 PID。' },
              },
            },
          },
          httpReachable: { type: 'boolean', required: true, description: 'HTTP 探测是否有响应。' },
          httpStatus: { type: 'integer', required: true, description: 'HTTP 状态码，0 表示未取到。' },
          httpServer: { type: 'string', required: true, description: 'Server 响应头。' },
          httpDshLike: { type: 'boolean', required: true, description: 'HTTP 响应是否带 DSH 指纹。' },
          httpDetail: { type: 'string', required: true, description: 'HTTP 探测结论。' },
          listenerError: { type: 'string', required: true, description: '监听者枚举的降级说明，空串表示正常。' },
          freePorts: { type: 'array', required: true, description: '可用的备用端口（最多 3 个）。', items: { type: 'integer' } },
          advice: { type: 'array', required: true, description: '处置建议，按优先级排列。', items: { type: 'string' } },
          summary: { type: 'string', required: true, description: '一行结论。' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatReport(value) }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args ?? {};
      const selfPort = readSelfPort(ctx);
      const port = Number.isInteger(input.port) ? input.port : selfPort > 0 ? selfPort : config.port;
      const host = typeof input.host === 'string' && input.host !== '' ? input.host : config.host;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`port_doctor: \`port\` 必须是 1-65535 的整数，收到 ${JSON.stringify(input.port)}`);
      }
      return diagnose({ port, host, selfPort, selfPid: process.pid, scan: input.scan !== false }, exec.signal);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `端口诊断 · :${args?.port ?? '当前端口'}`,
      kind: 'other',
      rawInput: args,
    }),
  }));
}
