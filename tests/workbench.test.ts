import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store';
import { parseOutput, executeRun } from '../lib/model';
import { exampleHtml } from '../lib/example';
import { previewDocument } from '../lib/preview';

function fixture() { const store = new Store(':memory:'); const p = store.create('owner', '测试项目'); return { store, p }; }
test('project ownership is enforced on reads, restores and state writes', () => {
  const { store, p } = fixture();
  try {
    assert.equal(store.list('other').length, 0);
    assert.throws(() => store.detail('other', p.id), /无权访问/);
    assert.throws(() => store.restore('other', p.id, 'x'), /无权访问/);
    assert.throws(() => store.state('other', p.id, {}), /无权访问/);
  } finally { store.db.close(); }
});
test('same request is idempotent; a second concurrent run is rejected', () => {
  const { store, p } = fixture();
  try {
    const first = store.begin('owner', p.id, 'one', '生成待办', null);
    const duplicate = store.begin('owner', p.id, 'one', '生成待办', null);
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(duplicate.reused, true);
    assert.equal(store.detail('owner', p.id).messages.length, 1);
    assert.throws(() => store.begin('owner', p.id, 'two', '其他需求', null), /正在生成/);
  } finally { store.db.close(); }
});
test('failure preserves previous code and recovery appends a version', () => {
  const { store, p } = fixture();
  try {
    const old = store.saveVersion(p.id, exampleHtml, '原版', null, null);
    const run = store.begin('owner', p.id, 'one', '修改', old.id).run;
    store.fail(run.id, '模型超时');
    assert.equal(store.project('owner', p.id).currentVersionId, old.id);
    const restored = store.restore('owner', p.id, old.id);
    assert.equal(restored.number, 2);
    const detail = store.detail('owner', p.id);
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.versions[1].id, old.id);
    assert.equal(restored.html, exampleHtml);
    assert.equal(detail.runs[0].error, '模型超时');
  } finally { store.db.close(); }
});
test('stale output cannot replace a newer current version', () => {
  const { store, p } = fixture();
  try {
    const run = store.begin('owner', p.id, 'one', '修改', null).run;
    const newer = store.saveVersion(p.id, exampleHtml, '更新', null, null);
    assert.throws(() => store.finish('owner', p.id, run.id, exampleHtml, '过期'), /基准版本已变化/);
    assert.equal(store.project('owner', p.id).currentVersionId, newer.id);
    assert.throws(() => store.restore('owner', p.id, newer.id), /生成中无法恢复/);
  } finally { store.db.close(); }
});
test('app data and history survive restart; unfinished runs become failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atoms-test-'));
  const path = join(dir, 'db.sqlite');
  let store = new Store(path);
  try {
    const p = store.create('owner', '保存测试');
    store.state('owner', p.id, { tasks: [{ text: '保存的任务', done: true }] });
    const run = store.begin('owner', p.id, 'one', '生成', null).run;
    store.db.close(); store = new Store(path);
    assert.deepEqual(store.detail('owner', p.id).appState, { tasks: [{ text: '保存的任务', done: true }] });
    assert.equal(store.run('owner', p.id, run.id).status, 'failed');
    assert.match(store.run('owner', p.id, run.id).error!, /重启/);
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});
test('HTML validation accepts the example and rejects broken syntax or external script', () => {
  assert.equal(parseOutput(JSON.stringify({ html: exampleHtml, summary: '示例' })).html, exampleHtml);
  assert.throws(() => parseOutput('{bad}'), /JSON/);
  assert.throws(() => parseOutput(JSON.stringify({ html: exampleHtml.replace('let tasks=', 'let = ='), summary: '错误' })), /语法/);
  assert.throws(() => parseOutput(JSON.stringify({ html: exampleHtml.replace('</head>', '<script src="https://example.com/x.js"></script></head>'), summary: '错误' })), /外部脚本/);
});
test('preview injects restrictions before generated scripts and escapes stored content', () => {
  const doc = previewDocument(exampleHtml, 'token', { text: '</script><script>alert(1)</script>' });
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<style>'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(doc.includes("form-action 'none'"));
  assert.ok(doc.includes('\\u003c/script\\u003e'));
  assert.ok(!doc.includes('"text":"</script>'));
});
test('generator uses provider response and repairs invalid output once (mock provider)', async () => {
  const { store, p } = fixture();
  const fetchBefore = globalThis.fetch;
  const saved = { base: process.env.MODEL_BASE_URL, key: process.env.MODEL_API_KEY, name: process.env.MODEL_NAME };
  let calls = 0;
  process.env.MODEL_BASE_URL = 'http://127.0.0.1:9999/v1'; process.env.MODEL_API_KEY = 'test-key'; process.env.MODEL_NAME = 'test-model';
  globalThis.fetch = async (_input, init) => {
    calls++;
    const request = JSON.parse(init!.body as string);
    assert.equal(request.model, 'test-model');
    if (calls === 2) assert.match(request.messages.at(-1).content, /检查失败/);
    return Response.json({ choices: [{ message: { content: calls === 1 ? 'invalid' : JSON.stringify({ html: exampleHtml, summary: '模拟模型返回的修改结果' }) }, finish_reason: 'stop' }] });
  };
  try {
    const run = store.begin('owner', p.id, 'one', '生成待办', null).run;
    await executeRun(store, 'owner', p.id, run.id);
    assert.equal(calls, 2);
    assert.equal(store.run('owner', p.id, run.id).status, 'complete');
    assert.equal(store.detail('owner', p.id).versions[0].summary, '模拟模型返回的修改结果');
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries({ MODEL_BASE_URL: saved.base, MODEL_API_KEY: saved.key, MODEL_NAME: saved.name })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    store.db.close();
  }
});
test('daily model budget also blocks runs in other projects of the same session', () => {
  const { store, p } = fixture();
  const before = process.env.MODEL_DAILY_LIMIT;
  process.env.MODEL_DAILY_LIMIT = '1';
  try {
    store.begin('owner', p.id, 'one', '生成', null);
    const p2 = store.create('owner', '第二个项目');
    assert.throws(() => store.begin('owner', p2.id, 'two', '生成', null), /上限/);
  } finally { if (before === undefined) delete process.env.MODEL_DAILY_LIMIT; else process.env.MODEL_DAILY_LIMIT = before; store.db.close(); }
});
test('network and global daily limits persist across anonymous sessions', () => {
  const { store, p } = fixture();
  const before = { MODEL_IP_DAILY_LIMIT: process.env.MODEL_IP_DAILY_LIMIT, MODEL_GLOBAL_DAILY_LIMIT: process.env.MODEL_GLOBAL_DAILY_LIMIT };
  process.env.MODEL_IP_DAILY_LIMIT = '1'; process.env.MODEL_GLOBAL_DAILY_LIMIT = '2';
  try {
    const first = store.begin('owner', p.id, 'one', '生成', null, 'same-network').run;
    store.fail(first.id, 'test');
    const other = store.create('other-owner', '第二个会话');
    assert.throws(() => store.begin('other-owner', other.id, 'two', '生成', null, 'same-network'), /当前网络/);
    const second = store.begin('other-owner', other.id, 'two', '生成', null, 'other-network').run;
    store.fail(second.id, 'test');
    const third = store.create('third-owner', '第三个会话');
    assert.throws(() => store.begin('third-owner', third.id, 'three', '生成', null, 'third-network'), /总次数/);
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    store.db.close();
  }
});
test('global concurrency rejects a third running project', () => {
  const { store, p } = fixture();
  try {
    store.begin('owner', p.id, 'one', '生成', null);
    const second = store.create('other', '第二个项目');
    store.begin('other', second.id, 'two', '生成', null);
    const third = store.create('third', '第三个项目');
    assert.throws(() => store.begin('third', third.id, 'three', '生成', null), /任务较多/);
  } finally { store.db.close(); }
});
