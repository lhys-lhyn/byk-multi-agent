/* 左栏：角色花名册（GET /api/roles）+ 会话/回合列表 */

import { h, setText, fmtClock, truncate, STAGE_LABEL } from '../util.js';

export function createLeftRail({ ctx, rolesRoot, turnsRoot }) {
  /* ------------------------------------------------------- 角色花名册 */
  const rolesHead = h('div', { class: 'panel-head' },
    h('span', { class: 'panel-title' }, '角色花名册'),
    h('span', { class: 'panel-count', id: 'roles-count' }));
  const rolesBody = h('div', { class: 'panel-body' });
  rolesRoot.append(rolesHead, rolesBody);

  const roleRows = new Map();
  function syncRoles() {
    const roles = ctx.state.roles || [];
    setText(rolesHead.lastChild, `${roles.length} 个角色`);
    const keep = new Set();
    for (const r of roles) {
      keep.add(r.id);
      let row = roleRows.get(r.id);
      if (!row) {
        row = h('div', { class: 'role-row', dataset: { role: r.id } },
          h('span', { class: 'role-badge', dataset: { role: r.id } },
            h('span', { class: 'role-name' })),
          h('span', { class: 'role-model' }),
          h('span', { class: 'role-desc' }),
          h('span', { class: 'role-note hidden' }),
        );
        roleRows.set(r.id, row);
        rolesBody.append(row);
      }
      row.dataset.available = r.available === false ? 'false' : 'true';
      setText(row.querySelector('.role-name'), r.name || r.id);
      setText(row.querySelector('.role-model'), `${r.id} · ${r.model || '—'}${r.available === false ? ' · 不可用' : ''}`);
      const desc = row.querySelector('.role-desc');
      setText(desc, r.description || '');
      desc.title = r.description || '';
      const note = row.querySelector('.role-note');
      note.classList.toggle('hidden', !r.note);
      setText(note, r.note ? `⚠ ${r.note}` : '');
      note.title = r.note || '';
    }
    for (const [id, row] of [...roleRows]) if (!keep.has(id)) { row.remove(); roleRows.delete(id); }
  }

  /* --------------------------------------------------- 会话 / 回合列表 */
  const turnsHead = h('div', { class: 'panel-head' },
    h('span', { class: 'panel-title' }, '会话 / 回合'),
    h('span', { class: 'panel-count' }));
  const turnsBody = h('div', { class: 'panel-body' });
  turnsRoot.append(turnsHead, turnsBody);

  function stageTone(stage) {
    if (stage === 'completed') return 'tag ok';
    if (stage === 'failed' || stage === 'cancelled') return 'tag bad';
    if (stage === 'awaiting_confirmation') return 'tag warn';
    return 'tag';
  }

  function syncTurns() {
    const state = ctx.state;
    setText(turnsHead.lastChild, `${state.turnOrder.length} 个回合`);
    const groups = new Map();     // session_id -> [turn]
    for (const id of state.turnOrder) {
      const t = state.turns.get(id);
      if (!t) continue;
      const sid = t.session_id || '(无会话)';
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(t);
    }
    const nodes = [];
    if (!groups.size) {
      nodes.push(h('div', { class: 'empty' }, '本页面还没有回合。发送一条需求后会出现。'));
    }
    for (const [sid, list] of groups) {
      nodes.push(h('div', { class: 'session-head' },
        h('span', {}, `会话 ${sid}`),
        h('span', { class: 'muted' }, `· ${list.length} 个回合`)));
      for (const t of list) {
        nodes.push(h('button', {
          class: 'turn-item', type: 'button',
          'aria-current': t.turn_id === state.activeTurnId ? 'true' : 'false',
          onclick: () => ctx.actions.selectTurn(t.turn_id),
        },
        h('div', { class: 'ti-top' },
          h('span', { class: 'ti-id' }, t.turn_id),
          h('span', { class: stageTone(t.doneStage || t.stage) }, STAGE_LABEL[t.doneStage || t.stage] || t.stage),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { class: 'muted' }, fmtClock(t.created_at))),
        h('div', { class: 'ti-text', title: t.user_text }, truncate(t.user_text || '（空输入）', 42))));
      }
    }
    turnsBody.replaceChildren(...nodes);
  }

  function sync() { syncRoles(); syncTurns(); }

  return { sync, syncRoles, syncTurns };
}
