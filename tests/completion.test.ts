import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completion } from '../lib/completion';
import { executeRun } from '../lib/model';
import { Store } from '../lib/store';
import { exampleHtml } from '../lib/example';

async function provider(fn: () => Promise<void>, config: Record<string, string> = {}) {
  const values = { MODEL_BASE_URL: 'http://127.0.0.1:9999/v1', MODEL_API_KEY: 'test-key', MODEL_NAME: 'test-model', MODEL_TIMEOUT_MS: '2000', MODEL_IDLE_TIMEOUT_MS: '1000', MODEL_THINKING: 'disabled', ...config };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, values);
  try { await fn(); } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
function stream(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
    c.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const data = (delta: Record<string, string>, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\r\n\r\n`;

test('stream parser handles split UTF-8, CRLF and reasoning without exposing reasoning text', async () => {
  await provider(async () => {
    const progress: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(init!.body as string);
      assert.equal(request.stream, true);
      assert.deepEqual(request.thinking, { type: 'disabled' });
      return stream(': heartbeat\r\n\r\n' + data({ reasoning_content: 'PRIVATE REASONING' }) + data({ content: '你好，' }) + data({ content: '世界' }) + data({}, 'stop') + 'data: [DONE]\r\n\r\n', 1);
    };
    assert.equal(await completion([{ role: 'user', content: '测试' }], p => progress.push(p)), '你好，世界');
    assert.ok(!JSON.stringify(progress).includes('PRIVATE REASONING'));
  });
});
test('truncated or unfinished SSE output is not accepted as a complete version', async () => {
  await provider(async () => {
    globalThis.fetch = async () => stream(data({ content: 'partial' }));
    await assert.rejects(completion([]), /提前中断/);
    globalThis.fetch = async () => stream(data({ content: 'partial' }, 'length'));
    await assert.rejects(completion([]), /截断/);
    globalThis.fetch = async () => stream('data: {broken}\n\n');
    await assert.rejects(completion([]), /无效的 JSON/);
  });
});
test('providers returning complete JSON remain compatible with stream requests', async () => {
  await provider(async () => {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] });
    assert.equal(await completion([]), 'complete');
  });
});
test('idle deadline stops a silent provider independently of the total deadline', async () => {
  await provider(async () => {
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await assert.rejects(completion([]), /未返回有效内容/);
  }, { MODEL_IDLE_TIMEOUT_MS: '25', MODEL_TIMEOUT_MS: '1000' });
});
test('empty provider heartbeats do not keep a stalled generation alive', async () => {
  await provider(async () => {
    let timer: ReturnType<typeof setInterval>;
    globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
      start(c) {
        timer = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 5);
        init!.signal!.addEventListener('abort', () => { clearInterval(timer); c.error(new Error('aborted')); }, { once: true });
      }, cancel() { clearInterval(timer); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(completion([]), /未返回有效内容/);
  }, { MODEL_IDLE_TIMEOUT_MS: '35', MODEL_TIMEOUT_MS: '1000' });
});
test('the total deadline still bounds an actively emitting model', async () => {
  await provider(async () => {
    let timer: ReturnType<typeof setInterval>;
    globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
      start(c) {
        timer = setInterval(() => c.enqueue(new TextEncoder().encode(data({ content: 'a' }))), 5);
        init!.signal!.addEventListener('abort', () => { clearInterval(timer); c.error(new Error('aborted')); }, { once: true });
      }, cancel() { clearInterval(timer); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    await assert.rejects(completion([]), /本次模型调用超过/);
  }, { MODEL_TIMEOUT_MS: '40', MODEL_IDLE_TIMEOUT_MS: '1000' });
});
test('repair has a fresh independent request deadline', async () => {
  await provider(async () => {
    const store = new Store(':memory:');
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
        const timer = setTimeout(() => { init!.signal!.removeEventListener('abort', abort); resolve(); }, 70);
        init!.signal!.addEventListener('abort', abort, { once: true });
      });
      return stream(data({ content: calls === 1 ? 'invalid' : JSON.stringify({ html: exampleHtml, summary: '已修复' }) }, 'stop'));
    };
    try {
      const project = store.create('owner', 'repair deadline');
      const run = store.begin('owner', project.id, 'one', '生成', null).run;
      await executeRun(store, 'owner', project.id, run.id);
      assert.equal(calls, 2);
      assert.equal(store.run('owner', project.id, run.id).status, 'complete');
    } finally { store.db.close(); }
  }, { MODEL_TIMEOUT_MS: '110', MODEL_IDLE_TIMEOUT_MS: '1000' });
});
test('a failed first generation never claims a previous version exists', async () => {
  await provider(async () => {
    const store = new Store(':memory:');
    globalThis.fetch = async () => { throw new Error('network'); };
    try {
      const project = store.create('owner', 'first failure');
      const run = store.begin('owner', project.id, 'one', '生成', null).run;
      await executeRun(store, 'owner', project.id, run.id);
      const result = store.run('owner', project.id, run.id);
      assert.match(result.error!, /首次生成失败/);
      assert.match(result.error!, /尚未生成可用版本/);
      assert.doesNotMatch(result.error!, /上一版本仍然保留/);
      assert.equal(store.detail('owner', project.id).versions.length, 0);
    } finally { store.db.close(); }
  });
});
