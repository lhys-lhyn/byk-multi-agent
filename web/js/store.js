/* 状态存储：唯一的真相来源（turn 快照 + SSE 事件归并）。
   所有写入都是按 id 幂等 upsert，因此「重连后重放快照」不会重复渲染。 */

import { nowIso, stageIndex } from './util.js';

const STREAM_CAP = 200_000; // 单个子任务单个流的缓冲上限（字符）

/** 状态单调性：快照/事件都不允许把子任务状态往回退（防止陈旧快照导致闪烁） */
const STATUS_RANK = { pending: 0, running: 1, succeeded: 2, failed: 2, skipped: 2, blocked: 2 };

function capAppend(prev, add) {
  const next = (prev || '') + (add || '');
  return next.length > STREAM_CAP ? next.slice(next.length - STREAM_CAP) : next;
}

function normalizeExtraction(x) {
  const e = x && typeof x === 'object' ? x : {};
  return {
    path: e.path || e.name || '(未知路径)',
    name: e.name || '',
    kind: e.kind || 'unknown',
    ok: e.ok !== false,
    text: typeof e.text === 'string' ? e.text : '',
    meta: e.meta && typeof e.meta === 'object' ? e.meta : {},
    error: e.error ?? null,
    method: e.method || '',
  };
}

function normalizeSubtask(st) {
  const s = st && typeof st === 'object' ? st : {};
  return {
    id: String(s.id || ''),
    title: s.title || '',
    role: s.role || '',
    detail: s.detail || '',
    status: s.status || 'pending',
    started_at: s.started_at ?? null,
    finished_at: s.finished_at ?? null,
    duration_s: s.duration_s ?? null,
    output: typeof s.output === 'string' ? s.output : '',
    log_tail: s.log_tail || '',
    error: s.error ?? null,
    artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
  };
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    goal: plan.goal || '',
    subtasks: (Array.isArray(plan.subtasks) ? plan.subtasks : []).map((s) => ({
      id: String(s.id || ''),
      title: s.title || '',
      detail: s.detail || '',
      role: s.role || 'task',
      depends_on: Array.isArray(s.depends_on) ? s.depends_on.map(String) : [],
      inputs: Array.isArray(s.inputs) ? s.inputs.map(String) : [],
      needs_privilege: !!s.needs_privilege,
      acceptance: s.acceptance || '',
    })),
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
    questions: Array.isArray(plan.questions) ? plan.questions.map(String) : [],
  };
}

function newTurnView(raw) {
  const v = {
    turn_id: raw.turn_id || '',
    session_id: raw.session_id || '',
    created_at: raw.created_at || nowIso(),
    user_text: raw.user_text || '',
    attachments: Array.isArray(raw.attachments) ? raw.attachments.slice() : [],
    stage: raw.stage || 'intake',
    extractions: [],
    extractionsByKey: new Map(),
    plan: null,
    planRevision: 0,        // 每收到一次 plan 事件自增，供计划卡片判断是否重建
    subtasks: [],
    subtaskById: new Map(),
    streams: new Map(),     // subtask_id -> {stdout, stderr}
    summary: null,
    error: null,
    doneStage: null,
    pending_confirmation: null,
    planDecision: null,     // 'approved' | 'rejected' | 'cancelled'（本地乐观标记）
    lastEventAt: null,
    eventCount: 0,
  };
  return v;
}

export function createStore() {
  const listeners = new Map();

  function on(ev, cb) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(cb);
    return () => listeners.get(ev)?.delete(cb);
  }

  function emit(ev, payload) {
    for (const cb of listeners.get(ev) || []) {
      try { cb(payload); } catch (err) { console.error(`[store] 监听器异常 ${ev}`, err); }
    }
    if (ev !== '*') {
      for (const cb of listeners.get('*') || []) {
        try { cb({ event: ev, payload }); } catch (err) { console.error('[store] * 监听器异常', err); }
      }
    }
  }

  const state = {
    mode: 'live',                     // 'live' | 'mock'
    mockInfo: null,
    connection: {
      status: 'idle',                 // idle|connecting|open|reconnecting|closed|mock
      detail: '',
      openCount: 0,
      lastEventAt: null,
      lastError: null,
    },
    health: null,
    roles: [],
    precedents: [],
    turnOrder: [],
    turns: new Map(),
    activeTurnId: null,
    mockStep: null,
  };

  function ensureTurn(raw) {
    const id = raw.turn_id || '';
    let v = state.turns.get(id);
    if (!v) {
      v = newTurnView(raw);
      state.turns.set(id, v);
      state.turnOrder.push(id);
      emit('turns', { turnId: id, created: true });
    }
    return v;
  }

  function touch(v, reason) {
    v.lastEventAt = nowIso();
    v.eventCount += 1;
    emit('change', { reason, turn: v });
  }

  /* ---------------------------------------------------- 快照 / 事件归并 */

  function applySnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const v = ensureTurn(raw);
    v.session_id = raw.session_id || v.session_id;
    v.created_at = raw.created_at || v.created_at;
    v.user_text = raw.user_text ?? v.user_text;
    if (Array.isArray(raw.attachments)) v.attachments = raw.attachments.slice();

    // 阶段单调性：不接受会让阶段回退的陈旧快照（重连对齐时避免界面倒退）
    const curIdx = stageIndex(v.stage);
    const newIdx = stageIndex(raw.stage);
    if (raw.stage && newIdx >= 0 && curIdx >= 0 && newIdx < curIdx) {
      console.warn(`[store] 忽略会回退阶段的快照：${raw.stage} < ${v.stage}`);
    } else if (raw.stage) {
      v.stage = raw.stage;
    }

    if (Array.isArray(raw.extractions)) {
      for (const ex of raw.extractions) upsertExtraction(v, ex);
    }

    // plan 是权威值，但用户正在编辑的计划卡片不会被覆盖（由渲染层自行判断）
    if (raw.plan !== undefined) {
      const p = normalizePlan(raw.plan);
      const changed = JSON.stringify(p) !== JSON.stringify(v.plan);
      v.plan = p;
      if (changed && p) v.planRevision += 1;
      if (p) seedSubtasksFromPlan(v);
    }

    if (Array.isArray(raw.subtasks)) {
      const seen = new Set();
      for (const st of raw.subtasks) {
        const n = normalizeSubtask(st);
        if (!n.id) continue;
        seen.add(n.id);
        upsertSubtask(v, n);
      }
      const planIds = new Set((v.plan?.subtasks || []).map((s) => s.id));
      v.subtasks = v.subtasks.filter((s) => seen.has(s.id) || planIds.has(s.id));
    }

    v.summary = raw.summary === undefined ? v.summary : raw.summary;
    v.error = raw.error === undefined ? v.error : raw.error;
    v.pending_confirmation = raw.pending_confirmation ?? null;
    if (raw.pending_confirmation) v.planDecision = null;
    touch(v, 'snapshot');
    emit('snapshot', { turn: v });
    return v;
  }

  function upsertExtraction(v, ex) {
    const n = normalizeExtraction(ex);
    const key = n.path;
    const idx = v.extractionsByKey.get(key);
    if (idx !== undefined) {
      Object.assign(v.extractions[idx], n);       // 幂等更新
    } else {
      v.extractions.push(n);
      v.extractionsByKey.set(key, v.extractions.length - 1);
    }
    return n;
  }

  function upsertSubtask(v, st) {
    const n = normalizeSubtask(st);
    if (!n.id) return null;
    const cur = v.subtaskById.get(n.id);
    if (cur) {
      // 状态单调：不允许从 succeeded/failed/skipped/blocked 退回 pending/running
      if ((STATUS_RANK[n.status] ?? 0) < (STATUS_RANK[cur.status] ?? 0)) n.status = cur.status;
      if (!n.output && cur.output) n.output = cur.output;      // 不丢已有最终输出
      if (!n.started_at && cur.started_at) n.started_at = cur.started_at;
      Object.assign(cur, n);
      if (n.output) v.streams.delete(n.id);   // output 权威，丢弃流式缓冲，避免重复显示
      return cur;
    }
    v.subtasks.push(n);
    v.subtaskById.set(n.id, n);
    return n;
  }

  function seedSubtasksFromPlan(v) {
    for (const s of v.plan?.subtasks || []) {
      if (!s.id) continue;
      if (v.subtaskById.has(s.id)) continue;
      upsertSubtask(v, {
        id: s.id, title: s.title, role: s.role, detail: s.detail, status: 'pending',
      });
    }
  }

  /** 路由一条 SSE 事件（事件名严格按契约 §5） */
  function ingest(name, data) {
    const d = data && typeof data === 'object' ? data : {};
    const turnId = d.turn_id || state.activeTurnId;
    let v = turnId ? state.turns.get(turnId) : null;

    switch (name) {
      case 'snapshot':
        applySnapshot(d);
        return;
      case 'stage': {
        if (!v) return;
        v.stage = d.stage || v.stage;
        touch(v, 'stage');
        break;
      }
      case 'extraction': {
        if (!v) return;
        upsertExtraction(v, d.extraction || {});
        touch(v, 'extraction');
        break;
      }
      case 'plan': {
        if (!v) return;
        const p = normalizePlan(d.plan);
        if (p) {
          v.plan = p;
          v.planRevision += 1;
          seedSubtasksFromPlan(v);
        }
        touch(v, 'plan');
        break;
      }
      case 'subtask': {
        if (!v) return;
        const st = upsertSubtask(v, d.subtask || {});
        touch(v, 'subtask');
        break;
      }
      case 'agent_delta': {
        if (!v) return;
        const sid = d.subtask_id;
        if (!sid) return;
        const stream = d.stream === 'stderr' ? 'stderr' : 'stdout';
        let buf = v.streams.get(sid);
        if (!buf) { buf = { stdout: '', stderr: '' }; v.streams.set(sid, buf); }
        buf[stream] = capAppend(buf[stream], d.text || '');
        touch(v, 'delta');
        break;
      }
      case 'confirmation': {
        if (!v) return;
        v.pending_confirmation = d.confirmation || null;
        if (d.confirmation) v.planDecision = null;
        touch(v, 'confirmation');
        break;
      }
      case 'summary': {
        if (!v) return;
        v.summary = d.summary ?? '';
        touch(v, 'summary');
        break;
      }
      case 'error': {
        if (!v) return;
        v.error = d.message || '未知错误';
        touch(v, 'error');
        break;
      }
      case 'done': {
        if (!v) return;
        v.doneStage = d.stage || 'completed';
        v.stage = d.stage || v.stage;
        v.pending_confirmation = null;
        touch(v, 'done');
        break;
      }
      default:
        emit('unknown-event', { name, data: d });
    }
    state.connection.lastEventAt = nowIso();
  }

  /* ------------------------------------------------------------- 便捷方法 */

  function addTurnStub({ turn_id, session_id, user_text, attachments }) {
    const v = ensureTurn({ turn_id, session_id, user_text, attachments, stage: 'intake' });
    state.activeTurnId = turn_id;
    touch(v, 'turn-created');
    return v;
  }

  function selectTurn(id) {
    if (state.activeTurnId === id) return state.turns.get(id) || null;
    state.activeTurnId = id;
    emit('active-turn', { turnId: id });
    return state.turns.get(id) || null;
  }

  function setConnection(patch) {
    Object.assign(state.connection, patch);
    emit('connection', state.connection);
  }

  function markPlanDecision(turnId, decision) {
    const v = state.turns.get(turnId);
    if (!v) return;
    v.planDecision = decision;
    v.pending_confirmation = null;
    touch(v, 'plan-decision');
  }

  function clearConfirmation(turnId, cid) {
    const v = state.turns.get(turnId);
    if (!v) return;
    if (!cid || v.pending_confirmation?.id === cid) v.pending_confirmation = null;
    touch(v, 'confirmation-cleared');
  }

  function activeTurn() {
    return state.activeTurnId ? state.turns.get(state.activeTurnId) || null : null;
  }

  function streamText(v, subtaskId, stream) {
    const buf = v.streams.get(subtaskId);
    if (!buf) return '';
    return stream ? buf[stream] || '' : `${buf.stdout || ''}${buf.stderr || ''}`;
  }

  return {
    state, on, emit, ingest, applySnapshot, ensureTurn, addTurnStub, selectTurn,
    setConnection, markPlanDecision, clearConfirmation, activeTurn, streamText,
    normalizePlan, normalizeSubtask,
  };
}
