#!/usr/bin/env node
/**
 * 独立 CLI：DSH 起不来的时候也能诊断（插件工具只在 DSH 已经跑起来时才可用）。
 *
 *   npx dsh-port-doctor            # 诊断默认端口 3080
 *   npx dsh-port-doctor 3081       # 诊断指定端口
 *   npx dsh-port-doctor --json     # 输出机器可读 JSON
 *
 * 退出码：0=端口空闲，1=被占用，2=诊断出错。
 */

import { createRequire } from 'node:module';
import { DEFAULT_HOST, DEFAULT_PORT, diagnose, formatReport } from './engine.js';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const HELP = `dsh-port-doctor ${pkg.version}

用法：
  dsh-port-doctor [port] [--host <addr>] [--json] [--no-scan]

参数：
  port         要诊断的端口，默认 ${DEFAULT_PORT}
  --host       绑定地址，默认 ${DEFAULT_HOST}
  --json       输出完整 JSON（脚本用）
  --no-scan    不扫描可用备用端口
  -h, --help   显示帮助
  -v, --version 显示版本

退出码：0=空闲，1=被占用，2=出错
`;

/**
 * 解析命令行。
 * @param {string[]} argv - 去掉 node 与脚本路径后的参数。
 * @returns {{help: boolean, version: boolean, json: boolean, scan: boolean, port: number, host: string}} 解析结果。
 * @throws {Error} 参数非法时抛出。
 */
function parseArgv(argv) {
  const options = { help: false, version: false, json: false, scan: true, port: DEFAULT_PORT, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-scan') options.scan = false;
    else if (arg === '--host') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--host 需要一个地址');
      options.host = value;
      i += 1;
    } else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length);
    else if (/^\d+$/.test(arg)) options.port = Number(arg);
    else throw new Error(`无法识别的参数：${arg}`);
  }
  return options;
}

const argv = process.argv.slice(2);
let options;
try {
  options = parseArgv(argv);
} catch (error) {
  process.stderr.write(`${error.message}\n\n${HELP}`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (options.version) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

try {
  const result = await diagnose({ port: options.port, host: options.host, scan: options.scan });
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result)}\n`);
  process.exit(result.status === 'free' ? 0 : 1);
} catch (error) {
  process.stderr.write(`dsh-port-doctor: ${error?.message ?? String(error)}\n`);
  process.exit(2);
}
