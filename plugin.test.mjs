/**
 * 插件层测试：验证 defineTool 的 schema 能被接受、工具能注册、能跑出结果。
 * 需要 profile 的共享 node_modules（$DSH_HOME/profiles/node_modules）可解析
 * @deepseek-ai/dsh-tools；解析不到时整组跳过，不影响内核测试。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';

let plugin = null;
let loadError = '';
try {
  plugin = await import('./index.js');
} catch (error) {
  loadError = String(error?.message ?? error);
}

const skip = plugin === null ? `@deepseek-ai/dsh-tools 不可解析：${loadError}` : false;

test('插件导出 name/inject/Config/apply', { skip }, () => {
  assert.equal(plugin.name, 'port-doctor');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'function');
});

test('apply 注册 port_doctor，并输出结构化结果', { skip }, async () => {
  /** @type {any} */
  let registered;
  const ctx = {
    tools: { register(definition) { registered = definition; return () => {}; } },
    get() { return undefined; },
  };
  plugin.apply(ctx, { port: 3080, host: '127.0.0.1' });

  assert.equal(registered.name, 'port_doctor');
  assert.ok(registered.description.includes('EADDRINUSE'));
  assert.equal(registered.output.schema.type, 'object');
  assert.equal(registered.isConcurrencySafe({}), true);
  assert.equal(typeof registered.timeoutMs, 'number');

  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await registered.execute({ port }, { signal: new AbortController().signal });
    assert.equal(result.port, port);
    // 监听者就是本测试进程，所以正确结论是 self（工具把 process.pid 当 selfPid）。
    assert.equal(result.verdict, 'self');
    assert.equal(result.httpStatus, 401);
    assert.equal(typeof result.summary, 'string');

    const blocks = registered.output.render({ port }, result);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /self/);
    assert.match(blocks[0].text, /建议/);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('非法端口在工具边界被拒绝', { skip }, async () => {
  let registered;
  const ctx = { tools: { register(definition) { registered = definition; return () => {}; } }, get() { return undefined; } };
  plugin.apply(ctx, { port: 3080, host: '127.0.0.1' });
  await assert.rejects(() => registered.execute({ port: 70000 }, { signal: new AbortController().signal }), /1-65535/);
});
