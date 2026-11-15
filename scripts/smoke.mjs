// Exercises the running local API using a separate anonymous test session.
import assert from 'node:assert/strict';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3100';
let cookie = '';
async function call(path, body, extraHeaders = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = response.headers.get('set-cookie');
  if (session) cookie = session.split(';')[0];
  return { status: response.status, data: await response.json() };
}
const model = await call('status'); assert.equal(model.status, 200);
const created = await call('projects', { title: 'API smoke test', example: true });
assert.equal(created.status, 201);
const { project, versions } = created.data;
assert.equal(versions.length, 1);
const state = { tasks: [{ id: 1, text: 'API 保存测试', done: true }] };
assert.equal((await call(`projects/${project.id}/state`, { value: state })).status, 200);
assert.deepEqual((await call(`projects/${project.id}`)).data.appState, state);
assert.equal((await call(`projects/${project.id}/restore`, { versionId: versions[0].id })).data.versions.length, 2);
const forbidden = await call(`projects/${project.id}/state`, { value: {} }, { Origin: 'https://unrelated.example' });
assert.equal(forbidden.status, 403);
const ownerCookie = cookie; cookie = '';
assert.equal((await call(`projects/${project.id}`)).status, 404);
cookie = ownerCookie;
if (!model.data.configured) {
  const response = await call(`projects/${project.id}/runs`, { requestId: crypto.randomUUID(), prompt: '做一个计数器', baseVersionId: (await call(`projects/${project.id}`)).data.project.currentVersionId });
  assert.equal(response.status, 503);
  assert.match(response.data.error, /尚未配置模型/);
}
console.log('API smoke passed: project, example, persistence, restore, session isolation, CSRF and missing-model handling.');
