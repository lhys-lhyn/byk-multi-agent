/* 右栏：当前回合的阶段与子任务状态总览 + 状态色图例 + 先例库 */

import {
  h, setText, fmtClock, truncate,
  STAGE_LABEL, STAGE_ORDER, STATUS_LABEL, STATUS_ORDER, fmtDuration, resolveStageIndex,
} from '../util.js';
import { roleName } from '../roles.js';

const spacer = () => h('span', { style: { flex: '1 1 auto' } });

export function createInspector({ ctx, overviewRoot, precedentsRoot }) {
  /* ------------------------------------------------------ 总览面板 */
  const head = h('div', { class: 'panel-head' },
    h('span', { class: 'panel-title' }, '当前回合总览'),
    h('span', { class: 'panel-count' }));
  const body = h('div', { class: 'panel-body' });

  const stageLine = h('div', { class: 'stage-line' });
  const stepper = h('div', { class: 'stepper', id: 'ov-stepper' });
  const stats = h('div', { class: 'stat-grid' });
  const progress = h('div', { class: 'progress' });
  const miniList = h('div', { class: 'mini-list' });
  const connLine = h('div', { class: 'conn-line muted' });
  const submitLine = h('div', { class: 'submit-line mono hidden' });
  const legendTitle = h('div', { class: 'plan-section-title' }, '状态色图例');
  const legend = h('div', { class: 'legend' });
  const emptyEl = h('div', { class: 'empty' }, '尚无进行中的回合');

  const statCells = new Map();
  for (const [key, label] of [
    ['total', '总数'], ['succeeded', '完成'], ['running', '运行中'],
    ['pending', '待执行'], ['failed', '失败'], ['blocked', '受阻'],
  ]) {
    const v = h('div', { class: 'stat-v' }, '0');
    const cell = h('div', { class: 'stat' }, h('div', { class: 'stat-k' }, label), v);
    statCells.set(key, { cell, v });
    stats.append(cell);
  }

  for (const st of STATUS_ORDER) {
    legend.append(h('div', { class: 'legend-item' },
      h('span', { class: 'swatch', dataset: { status: st } }),
      h('span', {}, `${STATUS_LABEL[st]}（${st}）`)));
  }

  body.append(emptyEl, stageLine, stepper, stats, progress, miniList, legendTitle, legend, connLine, submitLine);
  overviewRoot.append(head, body);

  /* ------------------------------------------------------ 先例库面板 */
  const pHead = h('div', { class: 'panel-head' },
    h('span', { class: 'panel-title' }, '提权先例库'),
    h('span', { class: 'panel-count' }));
  const pBody = h('div', { class: 'panel-body' });
  precedentsRoot.append(pHead, pBody);

  const miniRows = new Map();

  function syncPrecedents() {
    const list = ctx.state.precedents || [];
    setText(pHead.lastChild, `${list.length} 条`);
    if (!list.length) {
      pBody.replaceChildren(h('div', { class: 'empty' }, '暂无先例（GET /api/precedents）'));
      return;
    }
    pBody.replaceChildren(...list.map((p) => h('div', { class: 'precedent' },
      h('div', { class: 'pc-top' },
        h('span', { class: 'pc-title', title: p.title || '' }, truncate(p.title || p.id, 30)),
        h('span', { class: 'pc-count' }, `成功 ${p.success_count ?? 0} 次`)),
      h('div', { class: 'pc-kw' }, ...(p.match_keywords || []).map((k) => h('span', { class: 'tag' }, k))),
      h('div', { class: 'pc-cmd', title: p.command_template || '' }, p.command_template || ''),
      h('div', { class: 'pc-meta' }, `密钥引用 ${p.secret_ref || '—'} · 最近 ${fmtClock(p.last_used_at) || '—'}`),
    )));
  }

  function syncOverview() {
    const turn = ctx.store.activeTurn();
    const has = !!turn;
    emptyEl.classList.toggle('hidden', has);
    for (const el2 of [stageLine, stepper, stats, progress, miniList]) el2.classList.toggle('hidden', !has);
    if (!has) {
      setText(head.lastChild, ctx.state.mode === 'mock' ? 'mock 回放' : '实时');
      setText(connLine, connText());
      return;
    }

    const stage = turn.doneStage || turn.stage;
    setText(head.lastChild, turn.turn_id);
    const stageTagCls = stage === 'completed' ? 'tag ok' : (stage === 'failed' || stage === 'cancelled') ? 'tag bad' : 'tag';
    stageLine.replaceChildren(
      h('span', { class: stageTagCls }, STAGE_LABEL[stage] || stage),
      h('span', { class: 'mono muted' }, turn.session_id || ''),
      spacer(),
      h('span', { class: 'muted' }, turn.summary ? '已汇总' : (turn.plan ? '已规划' : '未规划')),
    );

    // 阶段步进
    const cur = resolveStageIndex(turn);
    const terminalBad = turn.stage === 'failed' || turn.stage === 'cancelled';
    const completed = turn.doneStage === 'completed';
    stepper.replaceChildren(...STAGE_ORDER.flatMap((s, i) => {
      let state = 'todo';
      if (i < cur) state = 'done';
      else if (i === cur) state = terminalBad ? 'failed' : 'current';
      if (completed) state = 'done';
      const item = h('div', { class: 'step', dataset: { state } }, h('span', { class: 'step-dot' }), h('span', {}, STAGE_LABEL[s]));
      const sepDone = completed || i < cur || (i === cur && !terminalBad);
      return i ? [h('span', { class: 'step-sep', dataset: { state: sepDone ? 'done' : 'todo' } }), item] : [item];
    }));

    // 状态统计
    const counts = { total: turn.subtasks.length };
    for (const st of STATUS_ORDER) counts[st] = 0;
    for (const st of turn.subtasks) counts[st.status] = (counts[st.status] || 0) + 1;
    counts.blocked = (counts.blocked || 0) + (counts.skipped || 0);
    for (const [k, { v }] of statCells) setText(v, String(counts[k] ?? 0));

    // 进度条
    const total = Math.max(1, turn.subtasks.length);
    const segs = [];
    for (const st of ['succeeded', 'failed', 'blocked', 'skipped', 'running']) {
      const n = counts[st] || 0;
      if (!n) continue;
      segs.push(h('span', { class: `p-${st}`, style: { width: `${(n / total) * 100}%` }, title: `${STATUS_LABEL[st]} ${n}` }));
    }
    if (!segs.length) segs.push(h('span', { style: { width: '0%' } }));
    progress.replaceChildren(...segs);

    // 子任务小列表
    const keep = new Set();
    const nodes = [];
    for (const st of turn.subtasks) {
      keep.add(st.id);
      let row = miniRows.get(st.id);
      if (!row) {
        row = h('div', { class: 'mini-row' },
          h('span', { class: 'role-badge' }),
          h('span', { class: 'mr-title' }),
          h('span', { class: 'status-pill' }));
        miniRows.set(st.id, row);
      }
      row.querySelector('.role-badge').dataset.role = st.role || 'task';
      setText(row.querySelector('.role-badge'), roleName(st.role, ctx.state.roles));
      setText(row.querySelector('.mr-title'), st.title || st.id);
      row.querySelector('.mr-title').title = `${st.id}：${st.title || ''}`;
      const pill = row.querySelector('.status-pill');
      pill.dataset.status = st.status;
      setText(pill, `${STATUS_LABEL[st.status] || st.status}${st.duration_s ? ` · ${fmtDuration(st.duration_s)}` : ''}`);
      nodes.push(row);
    }
    for (const [id, row] of [...miniRows]) if (!keep.has(id)) { row.remove(); miniRows.delete(id); }
    miniList.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'empty' }, '计划尚未产出子任务')]));

    setText(connLine, connText());
    // mock 模式下把"后端实际收到的提权确认请求体"显示出来：截图里即可核对 secret_ref 有没有带上
    const last = ctx.state.mockLastSubmit;
    submitLine.classList.toggle('hidden', !last);
    if (last) {
      setText(submitLine, `mock 已收到确认提交：${JSON.stringify(last.body)}（cid=${last.cid}）`);
      submitLine.classList.toggle('crit', !('secret_ref' in last.body));
    }
  }

  function connText() {
    const c = ctx.state.connection;
    const parts = [
      ctx.state.mode === 'mock' ? `模式：mock 回放${ctx.state.mockStep ? `（步骤 ${ctx.state.mockStep}）` : ''}` : '模式：实时 SSE',
      `连接：${connLabel(c.status)}${c.openCount > 1 ? `（第 ${c.openCount} 次连接）` : ''}`,
    ];
    if (c.lastEventAt) parts.push(`最后事件 ${fmtClock(c.lastEventAt)}`);
    if (c.lastError) parts.push(`异常：${truncate(c.lastError, 60)}`);
    return parts.join(' · ');
  }

  function connLabel(s) {
    return ({
      idle: '未连接', connecting: '连接中', open: '已连接', reconnecting: '重连中',
      closed: '已断开', mock: 'mock（无网络）',
    })[s] || s;
  }

  function sync() { syncOverview(); syncPrecedents(); }

  return { sync, syncOverview, syncPrecedents };
}
