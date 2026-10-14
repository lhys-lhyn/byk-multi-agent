/* 时间线的非交互块：用户输入 / 提取结果 / 阶段进度 / 汇总 / 错误 / 等待占位
   全部按 id、按字段幂等更新，重复 sync 不产生重复 DOM。 */

import {
  h, setText, fmtBytes, fmtClock, truncate,
  KIND_LABEL, STAGE_LABEL, STAGE_ORDER, resolveStageIndex,
} from '../util.js';

const spacer = () => h('span', { style: { flex: '1 1 auto' } });

function card(cls) {
  const el = h('article', { class: `card ${cls}` });
  const head = h('div', { class: 'card-head' });
  const body = h('div', { class: 'card-body' });
  el.append(head, body);
  return { el, head, body };
}

/* ------------------------------------------------------------ 用户输入块 */

export function createUserBlock() {
  const { el, head, body } = card('block-user');
  const tag = h('span', { class: 'tag' }, '用户输入');
  const turnId = h('span', { class: 'ti-id mono' });
  const sess = h('span', { class: 'tag' });
  const time = h('span', { class: 'muted' });
  head.append(tag, turnId, sess, spacer(), time);
  const text = h('div', { class: 'user-text' });
  const chips = h('div', { class: 'chips' });
  body.append(text, chips);

  function sync(turn) {
    setText(turnId, turn.turn_id);
    setText(sess, turn.session_id ? `会话 ${turn.session_id}` : '未指定会话');
    setText(time, fmtClock(turn.created_at));
    setText(text, turn.user_text || '（空输入）');

    const want = turn.attachments || [];
    chips.replaceChildren(...want.map((a) => h('span', { class: 'chip', title: a.path || '' },
      h('span', { class: 'chip-name' }, a.name || '(未命名)'),
      h('span', { class: 'chip-meta' }, `${KIND_LABEL[a.kind] || a.kind || 'unknown'} · ${fmtBytes(a.size)}`),
    )));
    chips.classList.toggle('hidden', want.length === 0);
  }
  return { el, sync };
}

/* ------------------------------------------------------------ 提取结果块 */

function metaLine(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (meta.pages) parts.push(`${meta.pages} 页`);
  if (meta.chars) parts.push(`${meta.chars} 字符`);
  if (meta.bytes) parts.push(fmtBytes(meta.bytes));
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.fps) parts.push(`${meta.fps} fps`);
  if (meta.duration_s !== undefined) parts.push(`时长 ${Number(meta.duration_s).toFixed(1)}s`);
  if (meta.language) parts.push(`语言 ${meta.language}`);
  if (meta.sampled_frames) parts.push(`抽帧 ${meta.sampled_frames}`);
  if (Array.isArray(meta.members)) parts.push(`${meta.members.length} 个成员`);
  if (meta.truncated) parts.push('已截断');
  return parts.join(' · ');
}

export function createExtractBlock() {
  const { el, head, body } = card('block-extract');
  const count = h('span', { class: 'panel-count' });
  head.append(h('span', { class: 'tag' }, '提取结果'), h('span', { class: 'card-title' }, '附件解析'), spacer(), count);
  const rows = new Map();     // path -> 行元素

  function sync(turn) {
    const list = turn.extractions || [];
    setText(count, list.length ? `${list.length} 个文件` : '等待提取');
    const keep = new Set();
    for (const ex of list) {
      const key = ex.path;
      keep.add(key);
      let row = rows.get(key);
      if (!row) { row = makeRow(); rows.set(key, row); body.append(row.el); }
      row.sync(ex);
    }
    for (const [key, row] of rows) {
      if (!keep.has(key)) { row.el.remove(); rows.delete(key); }
    }
    if (!list.length) {
      if (!body.querySelector('.empty')) body.append(h('div', { class: 'empty' }, '还没有提取结果…'));
    } else {
      body.querySelector('.empty')?.remove();
    }
  }
  return { el, sync };
}

function makeRow() {
  const okTag = h('span', { class: 'tag' });
  const name = h('span', { class: 'ex-name mono' });
  const kind = h('span', { class: 'tag' });
  const method = h('span', { class: 'muted mono' });
  const toggle = h('button', { class: 'btn ghost sm', type: 'button' }, '查看文本');
  const meta = h('div', { class: 'ex-meta muted' });
  const err = h('div', { class: 'ex-err' });
  const pre = h('pre', { class: 'ex-text-pre' });
  const textWrap = h('div', { class: 'ex-text hidden' }, pre);
  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    textWrap.classList.toggle('hidden', !open);
    setText(toggle, open ? '收起文本' : '查看文本');
  });
  const el = h('div', { class: 'ex-row' },
    h('div', { class: 'ex-top' }, okTag, name, kind, method, spacer(), toggle),
    meta, err, textWrap,
  );

  function sync(ex) {
    setAttrClass(okTag, ex.ok ? 'tag ok' : 'tag bad', ex.ok ? 'OK' : '失败');
    setText(name, ex.name || ex.path);
    name.title = ex.path || '';
    setText(kind, KIND_LABEL[ex.kind] || ex.kind || 'unknown');
    setText(method, [ex.method || '', metaLine(ex.meta)].filter(Boolean).join(' · '));
    setText(meta, truncate(ex.path || '', 92));
    meta.title = ex.path || '';
    const hasErr = !!ex.error;
    err.classList.toggle('hidden', !hasErr);
    setText(err, hasErr ? `错误：${ex.error}` : '');
    const hasText = !!(ex.text && ex.text.trim());
    toggle.classList.toggle('hidden', !hasText);
    if (hasText) setText(pre, ex.text);
    if (!hasText) { open = false; textWrap.classList.add('hidden'); setText(toggle, '查看文本'); }
  }
  return { el, sync };
}

function setAttrClass(el, cls, text) {
  if (el.className !== cls) el.className = cls;
  setText(el, text);
}

/* ------------------------------------------------------------ 阶段进度块 */

export function createStageBlock() {
  const { el, head, body } = card('block-stage');
  head.append(h('span', { class: 'tag' }, '阶段进度'), spacer(), h('span', { class: 'muted' }));
  const label = head.lastChild;
  const stepper = h('div', { class: 'stepper' });
  const steps = STAGE_ORDER.map((s) => h('div', { class: 'step', dataset: { stage: s } },
    h('span', { class: 'step-dot' }), h('span', { class: 'step-label' }, STAGE_LABEL[s])));
  steps.forEach((s, i) => {
    if (i) stepper.append(h('span', { class: 'step-sep', dataset: { index: String(i) } }));
    stepper.append(s);
  });
  body.append(stepper);

  function sync(turn) {
    const st = turn.stage || 'intake';
    setText(label, `${STAGE_LABEL[st] || st}${turn.doneStage ? `（结束于 ${turn.doneStage}）` : ''}`);
    const cur = resolveStageIndex(turn);
    const terminalBad = st === 'failed' || st === 'cancelled' || (turn.doneStage && turn.doneStage !== 'completed');
    const completed = turn.doneStage === 'completed';
    steps.forEach((s, i) => {
      let state = 'todo';
      if (i < cur) state = 'done';
      else if (i === cur) state = terminalBad ? 'failed' : 'current';
      if (completed) state = 'done';
      if (s.dataset.state !== state) s.dataset.state = state;
    });
    body.querySelectorAll('.step-sep').forEach((sep, i) => {
      const done = completed || i + 1 < cur || (i + 1 === cur && !terminalBad);
      const state = done ? 'done' : 'todo';
      if (sep.dataset.state !== state) sep.dataset.state = state;
    });
  }
  return { el, sync };
}

/* ------------------------------------------------------------ 汇总 / 错误 */

export function createSummaryBlock() {
  const { el, head, body } = card('block-summary');
  const meta = h('span', { class: 'muted' });
  head.append(h('span', { class: 'tag ok' }, '汇总'), h('span', { class: 'card-title' }, '主对话结论'), spacer(), meta);
  const text = h('div', { class: 'user-text' });
  body.append(text);
  function sync(turn) {
    setText(meta, turn.doneStage ? `结束状态：${STAGE_LABEL[turn.doneStage] || turn.doneStage}` : '回合仍在进行');
    setText(text, turn.summary || '（暂无汇总内容）');
  }
  return { el, sync };
}

export function createErrorBlock() {
  const { el, head, body } = card('block-error');
  head.append(h('span', { class: 'tag bad' }, '错误'));
  const text = h('div', { class: 'user-text' });
  body.append(text);
  function sync(turn) { setText(text, turn.error || ''); }
  return { el, sync };
}

/* ------------------------------------------------------------ 等待占位 */

export function createWaitingBlock() {
  const { el, head, body } = card('block-placeholder');
  head.append(h('span', { class: 'tag' }, '进行中'));
  const text = h('div', { class: 'muted' });
  body.append(text);
  const HINTS = {
    intake: '已接收输入，准备提取附件…',
    extracting: '正在提取附件内容（本地 OCR / whisper / 解析），不使用 LLM…',
    planning: '任务助手正在拆解子任务并指派角色…',
  };
  function sync(turn) { setText(text, HINTS[turn.stage] || '等待后端事件…'); }
  return { el, sync };
}
