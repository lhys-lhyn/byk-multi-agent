/* 子任务卡片（契约 §6 第 4 项）：
   角色徽标 + 状态色（pending/running/succeeded/failed/skipped/blocked）+ 耗时 +
   可折叠实时输出（agent_delta 追加，自动滚到底部）+ 完成后的 output + artifacts。

   幂等要点：实时输出与最终输出都是「把 store 里的权威文本写进 <pre>」，
   反复 sync 或重连重放快照都不会重复追加。 */

import { h, setText, fmtDuration, elapsedSince, fmtClock, truncate, STATUS_LABEL } from '../util.js';
import { roleName } from '../roles.js';

export function createSubtaskCard({ ctx, id }) {
  const el = h('article', { class: 'card subtask', dataset: { st: id, status: 'pending' } });

  const roleBadge = h('span', { class: 'role-badge' });
  const titleEl = h('h3', { class: 'st-title' });
  const pill = h('span', { class: 'status-pill', dataset: { status: 'pending' } }, '待执行');
  const durEl = h('span', { class: 'st-dur' });
  const toggleBtn = h('button', { class: 'btn ghost sm toggle-output', type: 'button', onclick: () => setOpen(!open) }, '输出 ▾');
  const head = h('div', { class: 'card-head' }, roleBadge, titleEl, pill, durEl, toggleBtn);

  const metaEl = h('div', { class: 'st-meta' });
  const detailEl = h('div', { class: 'st-detail' });
  const errEl = h('div', { class: 'st-err hidden' });
  const artEl = h('div', { class: 'st-artifacts' });
  const bodyEl = h('div', { class: 'card-body' }, metaEl, detailEl, errEl, artEl);

  const streamTabs = h('div', { class: 'stream-tabs hidden' });
  const statEl = h('span', { class: 'out-stat' });
  const bar = h('div', { class: 'output-bar' },
    h('span', { class: 'out-label' }, '实时输出'), streamTabs, h('span', { style: { flex: '1 1 auto' } }), statEl);
  const livePre = h('pre', { class: 'live-output' });
  const finalPre = h('pre', { class: 'final-output' });
  const scroll = h('div', { class: 'output-scroll' }, livePre, finalPre);
  const outWrap = h('div', { class: 'output-wrap hidden' }, bar, scroll);

  el.append(head, bodyEl, outWrap);

  let open = false;
  let userTouched = false;         // 用户手动开合过输出区后，不再自动展开
  let stick = true;                // 输出区是否"贴底"（用户往上滚过就停止自动滚动）
  let activeStream = 'stdout';
  let userPickedStream = false;    // 用户手动切过 stdout/stderr 后不再自动切换
  let lastStreams = { stdout: '', stderr: '' };
  let firstRun = true;
  let lastStartedAt = null;

  scroll.addEventListener('scroll', () => {
    stick = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 24;
  });

  function setOpen(v) {
    open = v;
    userTouched = true;
    outWrap.classList.toggle('hidden', !open);
    setText(toggleBtn, `输出 ${open ? '▾' : '▸'}`);
    if (open) scroll.scrollTop = scroll.scrollHeight;
  }

  function renderTabs(streams, hasFinal) {
    const showErr = !!streams.stderr;
    streamTabs.classList.toggle('hidden', !showErr || hasFinal);
    if (activeStream === 'stderr' && !showErr) activeStream = 'stdout';
    const wanted = ['stdout', ...(showErr ? ['stderr'] : [])];
    const have = [...streamTabs.children].map((b) => b.dataset.stream);
    if (have.join(',') !== wanted.join(',')) {
      streamTabs.replaceChildren(...wanted.map((s) => h('button', {
        class: `stream-tab${s === activeStream ? ' active' : ''}`,
        type: 'button', dataset: { stream: s },
        onclick: () => { activeStream = s; userPickedStream = true; [...streamTabs.children].forEach((b) => b.classList.toggle('active', b.dataset.stream === s)); },
      }, s)));
    } else {
      [...streamTabs.children].forEach((b) => b.classList.toggle('active', b.dataset.stream === activeStream));
    }
  }

  function tick() {
    if (el.dataset.status !== 'running' || !lastStartedAt) return;
    const s = elapsedSince(lastStartedAt);
    if (s !== null) setText(durEl, `已运行 ${fmtDuration(s)}`);
  }

  function sync(turn) {
    const st = turn.subtaskById.get(id);
    if (!st) return;
    let status = st.status || 'pending';

    if (el.dataset.status !== status) el.dataset.status = status;
    setText(pill, STATUS_LABEL[status] || status);
    if (pill.dataset.status !== status) pill.dataset.status = status;

    if (roleBadge.dataset.role !== st.role) roleBadge.dataset.role = st.role || 'task';
    setText(roleBadge, roleName(st.role, ctx.state.roles));
    const rr = (ctx.state.roles || []).find((r) => r.id === st.role);
    roleBadge.title = rr ? (rr.description || '') : '';

    setText(titleEl, st.title || st.id);
    titleEl.title = st.title || '';

    lastStartedAt = st.started_at || null;
    if (status === 'running') {
      tick();
      if (!userTouched && firstRun) { open = true; outWrap.classList.remove('hidden'); setText(toggleBtn, '输出 ▾'); }
      firstRun = false;
    } else if (st.duration_s !== null && st.duration_s !== undefined) {
      setText(durEl, `耗时 ${fmtDuration(st.duration_s)}`);
    } else if (status === 'pending') {
      setText(durEl, '');
    }

    metaEl.replaceChildren(...metaParts(turn, st));

    setText(detailEl, st.detail || '');
    detailEl.classList.toggle('hidden', !st.detail);

    const hasErr = !!st.error;
    errEl.classList.toggle('hidden', !hasErr);
    setText(errEl, hasErr ? `错误：${st.error}` : '');

    const arts = st.artifacts || [];
    artEl.classList.toggle('hidden', arts.length === 0);
    artEl.replaceChildren(...arts.map((a) => h('span', { class: 'chip', title: a.path || '' },
      h('span', { class: 'chip-name' }, a.name || '产物'),
      a.kind ? h('span', { class: 'chip-meta' }, a.kind) : null,
    )));

    // 输出区：最终 output 优先，否则显示流式缓冲
    const streams = {
      stdout: (turn.streams.get(id)?.stdout) || '',
      stderr: (turn.streams.get(id)?.stderr) || '',
    };
    // 当前流没有内容、另一条流有内容时自动切过去（用户手动点过 tab 后不再自动切换）
    if (!userPickedStream && !st.output) {
      if (activeStream === 'stdout' && !streams.stdout && streams.stderr) activeStream = 'stderr';
      else if (activeStream === 'stderr' && !streams.stderr && streams.stdout) activeStream = 'stdout';
    }
    const final = st.output || '';
    const liveText = streams[activeStream] || '';
    const changed = streams.stdout !== lastStreams.stdout || streams.stderr !== lastStreams.stderr;
    lastStreams = streams;

    setText(finalPre, final);
    setText(livePre, final ? '' : liveText);
    setText(statEl, final
      ? `已完成 · 输出 ${final.length} 字符 · ${fmtDuration(st.duration_s)}`
      : (liveText ? `${activeStream} ${liveText.length} 字符` : '等待输出…'));
    setText(bar.querySelector('.out-label'), final ? '最终输出' : '实时输出');
    renderTabs(streams, !!final);

    if (open && stick && (changed || final)) scroll.scrollTop = scroll.scrollHeight;

    const toggleLabel = status === 'pending' && !final && !liveText ? '输出 ▸' : (open ? '输出 ▾' : '输出 ▸');
    toggleBtn.classList.toggle('hidden', status === 'pending' && !final && !liveText);
    setText(toggleBtn, toggleLabel);
  }

  function depChips(turn, id2) {
    const p = (turn.plan?.subtasks || []).find((s) => s.id === id2);
    if (!p) return [];
    const out = [];
    (p.depends_on || []).forEach((d) => out.push(h('span', { class: 'tag mono' }, `依赖 ${d}`)));
    (p.inputs || []).forEach((d) => out.push(h('span', { class: 'tag mono' }, `输入 ${d}`)));
    if (p.needs_privilege) out.push(h('span', { class: 'tag warn' }, '需提权'));
    if (p.acceptance) out.push(h('span', { class: 'tag', title: '验收标准' }, `验收：${truncate(p.acceptance, 40)}`));
    return out;
  }

  function metaParts(turn, st) {
    const parts = [];
    parts.push(h('span', { class: 'tag mono' }, st.id));
    parts.push(...depChips(turn, st.id));
    // 契约 §5：Confirmation 带 subtask_id —— 正在等这个子任务提权/等密钥时在卡片上标出来
    const pc = turn.pending_confirmation;
    if (pc && pc.subtask_id === st.id) {
      parts.push(h('span', { class: pc.requires_secret ? 'tag crit' : 'tag warn' },
        pc.requires_secret ? '等待密钥引用' : '等待提权确认'));
    }
    if (st.started_at) parts.push(h('span', { class: 'tag mono' }, `开始 ${fmtClock(st.started_at)}`));
    if (st.finished_at) parts.push(h('span', { class: 'tag mono' }, `结束 ${fmtClock(st.finished_at)}`));
    return parts;
  }

  return { el, sync, tick, id };
}
