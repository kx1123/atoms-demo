import { cookies } from 'next/headers';
import { randomBytes, createHash } from 'node:crypto';
import { AppError, getStore, isAppError } from '@/lib/store';
import { modelStatus, executeRun } from '@/lib/model';
import { exampleHtml } from '@/lib/example';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const method = request.method;
    const host = request.headers.get('host') || new URL(request.url).host;
    const hostUrl = new URL(`http://${host}`);
    const publicOrigin = process.env.ATOMS_PUBLIC_ORIGIN;
    if (!publicOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) throw new AppError('当前服务仅支持本机访问。', 403);
    const expectedOrigin = publicOrigin || hostUrl.origin;
    if (publicOrigin && hostUrl.host !== new URL(publicOrigin).host && !['127.0.0.1', 'localhost', '[::1]'].includes(hostUrl.hostname)) throw new AppError('站点地址不匹配。', 403);
    if (method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== expectedOrigin) throw new AppError('拒绝跨站写入请求。', 403);
      if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError('请使用 JSON 请求。', 415);
    }
    const jar = await cookies();
    let owner = jar.get('atoms_session')?.value;
    if (!owner || !/^[a-f0-9]{64}$/.test(owner)) {
      owner = randomBytes(32).toString('hex');
      jar.set('atoms_session', owner, { httpOnly: true, sameSite: 'strict', secure: new URL(expectedOrigin).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 365 });
    }
    const store = getStore();
    let body: Record<string, unknown> = {};
    if (method !== 'GET') {
      const text = await request.text();
      if (text.length > 150_000) throw new AppError('请求内容过大。', 413);
      try { body = JSON.parse(text); } catch { throw new AppError('无效的 JSON。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('无效的请求结构。');
    }
    if (path[0] === 'status' && method === 'GET') return json({ ...modelStatus(), deployment: publicOrigin ? 'server' : 'local' });
    if (path[0] === 'projects' && path.length === 1) {
      if (method === 'GET') return json(store.list(owner));
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title.trim() : '未命名项目';
        if (!title) throw new AppError('请输入项目名称。');
        const project = store.transaction(() => {
          const p = store.create(owner!, title);
          if (body.example === true) {
            store.saveVersion(p.id, exampleHtml, '交互示例：原生 JavaScript 待办应用，支持新增、完成、筛选和自动保存。', null, null);
            store.message(p.id, 'assistant', '这是预置的交互示例，并非 AI 生成。你可以操作右侧网页；配置模型后，可以继续用对话修改。');
          }
          return p;
        });
        return json(store.detail(owner, project.id), 201);
      }
    }
    if (path[0] === 'projects' && path[1]) {
      const id = path[1];
      store.project(owner, id);
      if (path.length === 2 && method === 'GET') return json(store.detail(owner, id));
      if (path[2] === 'restore' && method === 'POST') {
        if (typeof body.versionId !== 'string') throw new AppError('缺少版本 ID。');
        store.restore(owner, id, body.versionId);
        return json(store.detail(owner, id));
      }
      if (path[2] === 'state' && method === 'POST') {
        if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) throw new AppError('无效的应用状态。');
        store.state(owner, id, body.value as Record<string, unknown>);
        return json({ saved: true });
      }
      if (path[2] === 'runs' && path.length === 3 && method === 'POST') {
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 6000) throw new AppError('请输入 1 至 6000 字的需求。');
        if (typeof body.requestId !== 'string' || body.requestId.length > 100) throw new AppError('缺少有效的请求标识。');
        if (body.baseVersionId !== null && typeof body.baseVersionId !== 'string') throw new AppError('缺少基准版本。');
        if (!modelStatus().configured) throw new AppError('尚未配置模型。请在 .env.local 填写 MODEL_BASE_URL、MODEL_API_KEY 和 MODEL_NAME，再重启服务。', 503);
        // X-Real-IP is overwritten by the dedicated gateway; app port is not published.
        const client = process.env.TRUST_PROXY === 'true' ? request.headers.get('x-real-ip') || 'unknown' : 'local';
        const clientHash = createHash('sha256').update(client).digest('hex');
        const { run, reused } = store.begin(owner, id, body.requestId, body.prompt.trim(), body.baseVersionId as string | null, clientHash);
        if (!reused) void executeRun(store, owner, id, run.id);
        return json(run, reused ? 200 : 202);
      }
      if (path[2] === 'runs' && path[3] && path.length === 4 && method === 'GET') return json(store.run(owner, id, path[3]));
      if (path[2] === 'runs' && path[3] && path[4] === 'events' && method === 'GET') {
        const runId = path[3];
        store.run(owner, id, runId);
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setInterval> | undefined;
        let abort: (() => void) | undefined;
        const stream = new ReadableStream({
          start(controller) {
            let previous = '', closed = false;
            const close = () => {
              if (closed) return;
              closed = true; clearInterval(timer);
              if (abort) request.signal.removeEventListener('abort', abort);
              try { controller.close(); } catch { /* connection already closed */ }
            };
            const tick = () => {
              if (closed) return;
              try {
                const run = store.run(owner!, id, runId), serialized = JSON.stringify(run);
                if (serialized !== previous) { controller.enqueue(encoder.encode(`event: run\ndata: ${serialized}\n\n`)); previous = serialized; }
                else controller.enqueue(encoder.encode(': keepalive\n\n'));
                if (run.status !== 'running') close();
              } catch { close(); }
            };
            abort = close;
            timer = setInterval(tick, 1000);
            request.signal.addEventListener('abort', abort, { once: true });
            tick();
            if (request.signal.aborted) close();
          },
          cancel() { clearInterval(timer); if (abort) request.signal.removeEventListener('abort', abort); },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
      }
    }
    throw new AppError('接口不存在。', 404);
  } catch (error) {
    if (isAppError(error)) return json({ error: error.message }, error.status);
    console.error('API error:', error instanceof Error ? error.name : 'unknown');
    return json({ error: '本地服务发生错误，请稍后重试。' }, 500);
  }
}
export { handle as GET, handle as POST };
