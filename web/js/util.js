/* 通用工具：极简 DOM 构建器 + 格式化 + 契约枚举标签 */

/** 创建元素：h('div', {class:'x', onclick:fn}, child, ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  appendAll(el, children);
  return el;
}

export function appendAll(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** 只更新真正变化的文本，避免破坏选择/滚动状态 */
export function setText(el, text) {
  const s = text === null || text === undefined ? '' : String(text);
  if (el.textContent !== s) el.textContent = s;
}

export function setAttr(el, name, value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function truncate(s, n = 60) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '';
  const s = Number(sec);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}

/** 两个时间点之间的秒数（用于 running 状态下的实时计时） */
export function elapsedSince(startedAt, now = Date.now()) {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now - t) / 1000);
}

export function fmtClock(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ----------------------------------------------------------- 契约枚举 */

/** 契约 §5：turn.stage */
export const STAGE_ORDER = [
  'intake', 'extracting', 'planning', 'awaiting_confirmation',
  'executing', 'summarizing', 'completed',
];

export const STAGE_LABEL = {
  intake: '接收',
  extracting: '提取中',
  planning: '规划中',
  awaiting_confirmation: '等待确认',
  executing: '执行中',
  summarizing: '汇总中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const STAGE_SHORT = {
  intake: '接收',
  extracting: '提取',
  planning: '规划',
  awaiting_confirmation: '待确认',
  executing: '执行',
  summarizing: '汇总',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
};

/** 契约 §3：SubTaskState.status */
export const STATUS_ORDER = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'blocked'];

export const STATUS_LABEL = {
  pending: '待执行',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  blocked: '受阻',
};

export const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };

/** 契约 §3：ExtractionResult.kind */
export const KIND_LABEL = {
  document: '文档', image: '图片', audio: '音频', video: '视频',
  archive: '压缩包', text: '文本', unknown: '未知',
};

export function stageIndex(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i < 0 ? -1 : i;
}

/** failed / cancelled 这类终态在 STAGE_ORDER 里没有对应步骤，按已知进度推断停在哪一步 */
export function resolveStageIndex(turn) {
  const i = stageIndex(turn.stage);
  if (i >= 0) return i;
  const subs = turn.subtasks || [];
  const anyStarted = subs.some((s) => s && s.status && s.status !== 'pending');
  const cancelledEarly = turn.doneStage === 'cancelled' && !anyStarted;
  if (turn.plan) {
    return STAGE_ORDER.indexOf(anyStarted && !cancelledEarly ? 'executing' : 'awaiting_confirmation');
  }
  if ((turn.extractions || []).length) return STAGE_ORDER.indexOf('planning');
  return STAGE_ORDER.indexOf('extracting');
}

/* ------------------------------------------------- 契约 §5：提权确认的请求体 */

/**
 * 构造 POST /api/confirmations/{cid} 的请求体。
 *
 * 契约明确：`secret_ref` 为**可选字段**，"省略或为 null 时沿用后端匹配到先例所绑定的引用"。
 * 所以用户没填时**整个键都不出现**（不是空串、不是 null）。
 *
 * 这个函数是唯一的实现：HttpBackend 用它构造真正发出去的 body，
 * MockBackend 用它记录"如果发出去会是什么"（便于在没有后端的 mock 模式里断言线上格式）。
 */
export function confirmationBody(approved, remember, secretRef) {
  const body = { approved: !!approved, remember: !!remember };
  const ref = typeof secretRef === 'string' ? secretRef.trim() : '';
  if (ref) body.secret_ref = ref;
  return body;
}

export function debounce(fn, ms = 120) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

export function nowIso() { return new Date().toISOString(); }
