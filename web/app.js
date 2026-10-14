/* BYK 多智能体控制台 — 前端入口
   纯 ES module，无构建步骤。事件名/字段名严格按 docs/api-contract.md §5、§6。

   两种运行模式：
     实时（默认）        GET /api/health,/api/roles,/api/precedents + POST /api/turns + SSE /api/events
     mock（?mock=1）     不连任何后端，由 web/mock/replay.js 的脚本回放同一套事件
*/

import { createStore } from './js/store.js';
import { createBackend, readOptions } from './js/api.js';
import { mergeRoles } from './js/roles.js';
import { h, STAGE_LABEL } from './js/util.js';
import { createToaster } from './js/ui/toast.js';
import { createTimeline } from './js/ui/timeline.js';
import { createLeftRail } from './js/ui/leftrail.js';
import { createInspector } from './js/ui/inspector.js';
import { createComposer } from './js/ui/composer.js';
import { createConfirmModal } from './js/ui/confirm-modal.js';

/* ------------------------------------------------------------ 全局兜底 */
const fatalRoot = document.getElementById('fatal-root');
const shownErrors = new Set();
function showFatal(where, err) {
  const text = `${where}：${err && err.message ? err.message : String(err)}`;
  if (shownErrors.has(text)) return;
  shownErrors.add(text);
  console.error(text, err);
  fatalRoot.append(h('div', { class: 'fatal' },
    h('strong', {}, '界面发生未捕获的错误（这行提示也用于自检截图）'),
    h('pre', {}, `${text}\n${(err && err.stack) ? err.stack : ''}`)));
}
window.addEventListener('error', (e) => showFatal('运行错误', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal('未处理的 Promise 拒绝', e.reason));

/* ------------------------------------------------------------ 初始化 */
const options = readOptions();
const store = createStore();
const toast = createToaster(document.getElementById('toast-root'));
store.state.mode = options.mock ? 'mock' : 'live';
store.state.mockAnchor = options.at || '';

const ctx = {
  store,
  state: store.state,
  options,
  backend: null,
  toast,
  actions: {},
};

const badgesEl = document.getElementById('topbar-badges');
const timeline = createTimeline({ ctx, root: document.getElementById('timeline') });
const leftRail = createLeftRail({
  ctx,
  rolesRoot: document.getElementById('panel-roles'),
  turnsRoot: document.getElementById('panel-turns'),
});
const inspector = createInspector({
  ctx,
  overviewRoot: document.getElementById('panel-overview'),
  precedentsRoot: document.getElementById('panel-precedents'),
});
const composer = createComposer({ ctx, root: document.getElementById('composer') });
const modal = createConfirmModal({ ctx, root: document.getElementById('modal-root') });

/* ------------------------------------------------------------ 顶栏 */

function connectionBadge(c) {
  const map = {
    idle: ['warn', '未连接'], connecting: ['warn', '连接中'],
    open: ['ok', '事件流已连接'], reconnecting: ['warn', '重连中…'],
    closed: ['err', '事件流已断开'], mock: ['mock', 'mock：无网络'],
  };
  const [kind, text] = map[c.status] || ['warn', c.status];
  const tone = c.status === 'open' ? 'live' : c.status === 'reconnecting' ? 'reconnect' : c.status === 'closed' ? 'down' : '';
  return h('span', { class: 'badge', dataset: { kind, tone }, title: c.lastError || '' },
    h('span', { class: 'dot' }), text);
}

function renderHeader() {
  const s = ctx.state;
  const c = s.connection;
  const nodes = [];
  nodes.push(h('span', { class: 'badge', dataset: { kind: s.health ? 'ok' : 'warn' } },
    h('span', { class: 'dot' }),
    s.health ? `服务正常 · version ${s.health.version}` : '健康检查未完成'));
  if (s.mode === 'mock') {
    nodes.push(h('span', { class: 'badge', dataset: { kind: 'mock' }, title: '离线回放 web/mock/replay.js 的事件脚本' },
      h('span', { class: 'dot' }),
      `mock 回放${s.mockStep ? ` · ${s.mockStep}` : ''}${s.mockFrozen ? ` · 已冻结在 at=${s.mockAnchor}` : ''}`));
  } else {
    nodes.push(h('span', { class: 'badge' }, h('span', { class: 'dot' }), '实时 SSE'));
  }
  nodes.push(connectionBadge(c));
  const t = store.activeTurn();
  if (t) {
    nodes.push(h('span', { class: 'badge' },
      h('span', { class: 'dot' }),
      `${t.turn_id} · ${STAGE_LABEL[t.doneStage || t.stage] || t.stage}`));
  }
  badgesEl.replaceChildren(...nodes);
}

document.getElementById('btn-resync').addEventListener('click', () => {
  const t = store.activeTurn();
  if (!t) { toast('warn', '还没有回合可同步'); return; }
  resync(t.turn_id, {});
});

document.getElementById('btn-reconnect').addEventListener('click', () => {
  const t = store.activeTurn();
  if (options.mock) { toast('warn', 'mock 模式下没有网络连接可重连'); return; }
  if (!t) { toast('warn', '还没有回合可重连'); return; }
  unsubscribe?.();
  subscribe(t.turn_id);
  toast('ok', '已重建事件流连接');
});

/* ------------------------------------------------------------ 渲染调度 */

function renderTurn(turn) {
  timeline.sync(turn);
  modal.sync(turn);
  inspector.syncOverview();
  leftRail.syncTurns();
  renderHeader();
}

store.on('change', ({ turn }) => {
  if (!turn) return;
  if (turn.turn_id === store.state.activeTurnId) renderTurn(turn);
  else { leftRail.syncTurns(); }
});
store.on('turns', () => { leftRail.syncTurns(); renderHeader(); });
store.on('active-turn', ({ turnId }) => {
  const t = store.state.turns.get(turnId);
  timeline.sync(t);
  modal.sync(t);
  inspector.syncOverview();
  leftRail.syncTurns();
  renderHeader();
});
store.on('connection', () => { renderHeader(); inspector.syncOverview(); });
store.on('unknown-event', ({ name }) => console.warn('[sse] 未在契约中定义的事件名', name));

/* ------------------------------------------------------------ 事件流 */

let unsubscribe = null;
let resyncing = false;

function subscribe(turnId) {
  unsubscribe?.();
  unsubscribe = null;
  const isMock = options.mock;
  store.setConnection({
    status: isMock ? 'mock' : 'connecting',
    openCount: 0,
    lastError: null,
    detail: turnId,
  });
  unsubscribe = ctx.backend.subscribe(turnId, {
    onOpen: () => {
      const prev = store.state.connection.openCount;
      store.setConnection({ status: isMock ? 'mock' : 'open', openCount: prev + 1, lastError: null });
      // 重连成功（第二次 open）后主动拉一次快照对齐状态；幂等，不会重复渲染
      if (!isMock && prev >= 1) resync(turnId, { reason: '重连对齐' });
    },
    onEvent: (name, data) => {
      if (name === 'message') { console.warn('[sse] 收到未命名事件（缺 event: 字段）', data); return; }
      store.ingest(name, data);
    },
    onError: (es) => {
      if (isMock) return;
      const closed = es && es.readyState === EventSource.CLOSED;
      store.setConnection({
        status: closed ? 'closed' : 'reconnecting',
        lastError: closed ? 'EventSource 已关闭（服务端不可用或响应不是 text/event-stream）' : '连接中断，等待 EventSource 自动重连',
      });
      if (closed) toast('error', '事件流已断开，请点顶栏「重连事件流」');
    },
    onParseError: (name) => toast('error', `事件 ${name} 的 data 不是合法 JSON`),
  });
}

async function resync(turnId, { reason } = {}) {
  if (resyncing) return;
  resyncing = true;
  try {
    const raw = await ctx.backend.getTurn(turnId);
    store.applySnapshot(raw);                       // 按 id 幂等归并
    if (reason) toast('ok', `已按 ${reason} 重新对齐 ${turnId}`);
  } catch (err) {
    toast('error', `拉取回合快照失败：${err.message}`);
  } finally {
    resyncing = false;
  }
}

function openTurn(turnId) {
  const t = store.selectTurn(turnId);
  if (!t) { toast('error', `没有找到回合 ${turnId}`); return; }
  timeline.sync(t);
  modal.sync(t);
  inspector.syncOverview();
  leftRail.syncTurns();
  renderHeader();
  subscribe(turnId);
  if (!options.mock) resync(turnId, {});            // 与 SSE 首帧 snapshot 双保险（幂等）
}

/* ------------------------------------------------------------ 动作 */

ctx.actions = {
  async createTurn({ text, files = [] }) {
    const active = store.activeTurn();
    const res = await ctx.backend.createTurn({
      text,
      files,
      sessionId: active ? active.session_id : null,
    });
    if (!res || !res.turn_id) throw new Error('后端未返回 turn_id');
    store.addTurnStub({
      turn_id: res.turn_id,
      session_id: res.session_id,
      user_text: text || '（仅附件）',
      attachments: files.map((f, i) => ({ id: `local-${i}`, name: f.name, kind: 'unknown', size: f.size, path: f.name })),
    });
    openTurn(res.turn_id);
    ctx.toast('ok', `已创建回合 ${res.turn_id}`);
    return res;
  },

  async selectTurn(turnId) {
    openTurn(turnId);
  },

  async confirmPlan(turnId, approved, plan) {
    await ctx.backend.confirmPlan(turnId, approved, plan);
    store.markPlanDecision(turnId, approved ? 'approved' : 'cancelled');
    if (options.mock && plan) {
      // mock：让快照里的计划与用户编辑结果一致
      store.state.turns.get(turnId).plan = store.normalizePlan(plan);
    }
    const t = store.state.turns.get(turnId);
    if (t) renderTurn(t);
  },

  async cancelTurn(turnId) {
    await ctx.backend.cancelTurn(turnId);
    store.markPlanDecision(turnId, 'cancelled');
    const t = store.state.turns.get(turnId);
    if (t) renderTurn(t);
  },

  async decideConfirmation(turnId, cid, approved, remember, secretRef) {
    await ctx.backend.confirmPrivilege(cid, approved, remember, secretRef);
    store.clearConfirmation(turnId, cid);
    const t = store.state.turns.get(turnId);
    if (t) renderTurn(t);
  },
};

/* ------------------------------------------------------------ 启动 */

async function loadMeta() {
  try {
    ctx.state.health = await ctx.backend.health();
  } catch (err) {
    ctx.toast('warn', `GET /api/health 失败：${err.message}`);
  }
  try {
    ctx.state.roles = mergeRoles(await ctx.backend.roles());
  } catch (err) {
    ctx.state.roles = mergeRoles([]);
    ctx.toast('warn', `GET /api/roles 失败，使用内置角色表：${err.message}`);
  }
  try {
    ctx.state.precedents = await ctx.backend.precedents();
  } catch (err) {
    ctx.state.precedents = [];
    ctx.toast('warn', `GET /api/precedents 失败：${err.message}`);
  }
  leftRail.syncRoles();
  inspector.syncPrecedents();
  renderHeader();
}

async function bootMock() {
  const mock = ctx.backend;
  try {
    const list = await mock.listTurns();
    for (const t of list) {
      const v = store.ensureTurn(t);
      v.stage = t.stage;
      v.user_text = t.user_text;
      v.created_at = t.created_at;
    }
    leftRail.syncTurns();
  } catch (err) { showFatal('mock 历史回合加载失败', err); }

  ctx.toast('ok', `mock 模式：回放 ${options.at ? `锚点 ${options.at}` : '完整过程'}${options.at ? '（到锚点即冻结）' : ''}`, 6000);

  // 自动创建一个演示回合并开始回放，页面一打开就能看到动画
  const res = await ctx.backend.createTurn({ text: '', files: [] });
  const snap = await ctx.backend.getTurn(res.turn_id);
  store.applySnapshot(snap);
  openTurn(res.turn_id);
}

async function boot() {
  try {
    ctx.backend = await createBackend({ store, options });
  } catch (err) {
    showFatal('后端初始化失败', err);
    ctx.toast('error', `初始化失败：${err.message}。mock 模式请通过 http 打开（file:// 会被浏览器拦截）。`, 12000);
    return;
  }
  await loadMeta();

  if (options.mock) {
    ctx.backend.onStep = (info) => {
      ctx.state.mockStep = info.step;
      if (info.frozen) {
        ctx.state.mockFrozen = true;
        ctx.state.mockAnchor = info.anchor || options.at;
      }
      renderHeader();
      inspector.syncOverview();
    };
    // mock 后端收到的提权确认请求体（用于断言 secret_ref 是否随批准一起提交）
    ctx.backend.onSubmit = (body, cid) => {
      ctx.state.mockLastSubmit = { body, cid, at: new Date().toISOString() };
      inspector.syncOverview();
    };
    await bootMock();
  } else {
    const deep = new URLSearchParams(location.search).get('turn_id');
    if (deep) {
      store.addTurnStub({ turn_id: deep, session_id: '', user_text: '（来自 URL 深链，等待快照）', attachments: [] });
      openTurn(deep);
    } else {
      timeline.sync(null);
      inspector.syncOverview();
    }
  }

  // 实时耗时刷新
  setInterval(() => {
    try { timeline.tick(); } catch (err) { console.error(err); }
  }, 500);

  composer.focus();
}

boot();
