/* 后端访问层：HttpBackend（真实 FastAPI / byk/server.py）与 MockBackend（回放）
   必须保持完全相同的接口，app.js 不区分二者。路径/字段严格按 docs/api-contract.md §5。 */

import { MockBackend } from './mock-backend.js';
import { confirmationBody } from './util.js';

export { confirmationBody };

const SSE_EVENTS = [
  'snapshot', 'stage', 'extraction', 'plan', 'subtask',
  'agent_delta', 'confirmation', 'summary', 'error', 'done',
];

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;                       // 浏览器自动带 multipart 边界
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = (data && typeof data === 'object' && (data.detail || data.error)) || text || res.statusText;
    const err = new Error(`${method} ${url} → HTTP ${res.status}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export class HttpBackend {
  constructor({ base = '' } = {}) { this.base = base; this.es = null; }

  async health() { return req('GET', `${this.base}/api/health`); }
  async roles() { return req('GET', `${this.base}/api/roles`); }
  async precedents() { return req('GET', `${this.base}/api/precedents`); }
  async getTurn(turnId) { return req('GET', `${this.base}/api/turns/${encodeURIComponent(turnId)}`); }

  async createTurn({ text, files = [], sessionId = null }) {
    const fd = new FormData();
    fd.append('text', text ?? '');
    for (const f of files) fd.append('files', f, f.name);
    if (sessionId) fd.append('session_id', sessionId);
    return req('POST', `${this.base}/api/turns`, fd);
  }

  async confirmPlan(turnId, approved, plan) {
    return req('POST', `${this.base}/api/turns/${encodeURIComponent(turnId)}/confirm`, { approved, plan: plan ?? null });
  }

  async cancelTurn(turnId) {
    return req('POST', `${this.base}/api/turns/${encodeURIComponent(turnId)}/cancel`);
  }

  async confirmPrivilege(cid, approved, remember, secretRef) {
    // 契约 §5：secret_ref 可选；"用户没填"时整个键不出现（见 util.confirmationBody）
    return req('POST', `${this.base}/api/confirmations/${encodeURIComponent(cid)}`,
      confirmationBody(approved, remember, secretRef));
  }

  /** 订阅 SSE：契约 §5 的事件名逐一注册；断线由 EventSource 自动重连，onOpen 每次都回调 */
  subscribe(turnId, handlers) {
    this.close();
    const url = `${this.base}/api/events?turn_id=${encodeURIComponent(turnId)}`;
    const es = new EventSource(url);
    this.es = es;

    es.addEventListener('open', () => handlers.onOpen?.());
    es.addEventListener('error', () => handlers.onError?.(es));
    for (const name of SSE_EVENTS) {
      es.addEventListener(name, (ev) => {
        // 注意：EventSource 自身的连接错误事件也叫 "error"，但它不是 MessageEvent，
        // 绝不能被当成契约中的 error 事件，否则断线时会凭空冒出一条"未知错误"。
        if (!(ev instanceof MessageEvent)) return;
        if (ev.data === undefined || ev.data === null || ev.data === '') return;
        let data = null;
        try {
          data = JSON.parse(ev.data);
        } catch (err) {
          console.error(`[sse] 事件 ${name} 的 data 不是合法 JSON`, ev.data);
          handlers.onParseError?.(name, ev.data);
          return;
        }
        handlers.onEvent(name, data);
      });
    }
    // 契约要求带 event: 名；若后端漏写事件名会落到 message，这里兜底当作未知事件上报
    es.addEventListener('message', (ev) => {
      if (!ev.data) return;
      try { handlers.onEvent('message', JSON.parse(ev.data)); } catch { /* ignore */ }
    });

    return () => this.close();
  }

  close() {
    if (this.es) { try { this.es.close(); } catch { /* ignore */ } this.es = null; }
  }
}

/** 解析 URL 参数：?mock=1 / ?at=plan / ?speed=fast */
export function readOptions() {
  const p = new URLSearchParams(location.search);
  const mockRaw = (p.get('mock') || '').toLowerCase();
  const mock = mockRaw === '1' || mockRaw === 'true' || mockRaw === 'yes' || p.has('at');
  return { mock, at: p.get('at') || '', speed: p.get('speed') || 'normal', params: p };
}

export async function createBackend({ store, options }) {
  if (options.mock) {
    const backend = new MockBackend({ store, params: options.params });
    await backend.init();
    return backend;
  }
  return new HttpBackend({});
}
