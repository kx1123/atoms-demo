import { AppError } from './store';

type ChatMessage = { role: string; content: string };
type Progress = { elapsedSeconds: number; contentCharacters: number; receivedReasoning: boolean };
// SSE envelopes repeat metadata for every token; allow overhead while bounding output.
const MAX_RESPONSE_BYTES = 8_000_000;

function milliseconds(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(Math.floor(value), 600_000)) : fallback;
}

/** Read only final-answer content. Reasoning text is never retained or exposed. */
export async function completion(messages: ChatMessage[], onProgress: (progress: Progress) => void = () => {}) {
  const base = process.env.MODEL_BASE_URL!.replace(/\/+$/, '');
  const endpoint = new URL(base.endsWith('/chat/completions') ? base : `${base}/chat/completions`);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new AppError('模型地址需使用 HTTPS；本机模型可以使用 HTTP。');
  const timeoutMs = milliseconds('MODEL_TIMEOUT_MS', 300_000);
  const idleMs = milliseconds('MODEL_IDLE_TIMEOUT_MS', 90_000);
  const controller = new AbortController();
  let timedOut: 'total' | 'idle' | null = null;
  const abort = (kind: 'total' | 'idle') => { if (!controller.signal.aborted) { timedOut = kind; controller.abort(); } };
  const totalTimer = setTimeout(() => abort('total'), timeoutMs);
  let idleTimer = setTimeout(() => abort('idle'), idleMs);
  const activity = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort('idle'), idleMs); };
  const started = Date.now();
  let content = '', receivedReasoning = false, lastProgress = 0;
  const progress = () => {
    const now = Date.now();
    if (now - lastProgress < 1000) return;
    lastProgress = now;
    onProgress({ elapsedSeconds: Math.floor((now - started) / 1000), contentCharacters: content.length, receivedReasoning });
  };
  const heartbeat = setInterval(progress, 3000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const thinking = process.env.MODEL_THINKING;
    if (thinking && !['enabled', 'disabled'].includes(thinking)) throw new AppError('MODEL_THINKING 仅支持 enabled 或 disabled。');
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
      body: JSON.stringify({ model: process.env.MODEL_NAME, messages, stream: true, max_tokens: 12000, ...(thinking ? { thinking: { type: thinking } } : {}) }),
    });
    if (!response.ok) throw new AppError(`模型服务返回 HTTP ${response.status}，请检查凭证、额度与模型配置。`);
    reader = response.body?.getReader();
    if (!reader) throw new AppError('模型服务没有返回内容。');
    const streaming = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '', size = 0, finished = false;
    const consume = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') { finished = true; return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new AppError('模型流式响应包含无效的 JSON。'); }
      if (parsed.error) throw new AppError('模型服务在输出过程中返回错误，请稍后重试。');
      const choice = parsed.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason === 'length') throw new AppError('模型输出被截断，请缩小需求后重试。');
      if (choice.finish_reason === 'stop') finished = true;
      if (choice.finish_reason === 'content_filter') throw new AppError('模型服务未能完成该需求，请调整描述后重试。');
      const delta = choice.delta;
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) { receivedReasoning = true; activity(); }
      if (typeof delta?.content === 'string' && delta.content) {
        content += delta.content;
        if (content.length > 512_000) throw new AppError('模型生成内容超过大小限制，请缩小需求后重试。');
        activity();
      }
      progress();
    };
    while (!finished) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw new Error('Aborted');
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new AppError('模型响应超过 8 MB 限制。');
      buffer += decoder.decode(value, { stream: true });
      if (streaming) {
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          consume(line);
          if (finished) break;
        }
      } else {
        // Providers that ignore stream:true can still return a complete JSON response.
        activity(); progress();
      }
    }
    buffer += decoder.decode();
    if (streaming) {
      if (!finished && buffer.trim()) consume(buffer.replace(/\r$/, ''));
      if (!finished) throw new AppError('模型输出连接提前中断，未保存不完整版本，请重试。');
    } else {
      let parsed;
      try { parsed = JSON.parse(buffer); } catch { throw new AppError('模型服务响应不是有效的 JSON。'); }
      if (parsed.error) throw new AppError('模型服务返回错误，请稍后重试。');
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === 'length') throw new AppError('模型输出被截断，请缩小需求后重试。');
      if (typeof choice?.message?.content !== 'string') throw new AppError('模型服务返回的格式与 Chat Completions 不兼容。');
      content = choice.message.content;
    }
    if (!content.trim()) throw new AppError('模型没有返回可用代码，请重试。');
    return content;
  } catch (error) {
    if (timedOut === 'total') throw new AppError(`本次模型调用超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止等待。`);
    if (timedOut === 'idle') throw new AppError(`模型连续 ${Math.ceil(idleMs / 1000)} 秒未返回有效内容，已停止等待，请稍后重试。`);
    throw error;
  } finally {
    clearTimeout(totalTimer); clearTimeout(idleTimer); clearInterval(heartbeat);
    await reader?.cancel().catch(() => {});
  }
}
