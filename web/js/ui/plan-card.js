/* 计划确认卡片（契约 §6 第 3 项，用户明确要求的交互）：
   - 展示 plan.goal / assumptions / questions
   - 每个子任务可改派角色（下拉，选项来自 /api/roles）并编辑标题与说明
   - 「确认执行」把（可能已编辑的）TaskPlan 回传 POST /api/turns/{id}/confirm
   - 「取消」调用 POST /api/turns/{id}/cancel
   幂等：计划内容未变时复用已构建的行，用户正在编辑时绝不用远端快照覆盖输入。 */

import { h, setText, STAGE_LABEL } from '../util.js';
import { ROLE_IDS, roleName } from '../roles.js';

const spacer = () => h('span', { style: { flex: '1 1 auto' } });
const LOCKED_STAGES = ['executing', 'summarizing', 'completed', 'failed', 'cancelled'];

export function createPlanCard({ ctx }) {
  const el = h('article', { class: 'card block-plan', id: 'block-plan' });
  const head = h('div', { class: 'card-head' });
  const statusTag = h('span', { class: 'tag' });
  const goalMeta = h('span', { class: 'muted' });
  head.append(h('span', { class: 'tag' }, '计划确认'), h('span', { class: 'card-title' }, '任务计划'),
    spacer(), goalMeta, statusTag);

  const goalEl = h('div', { class: 'plan-goal' });
  const assumBox = h('div', { class: 'plan-block' });
  const questBox = h('div', { class: 'plan-block' });
  const table = h('div', { class: 'plan-table' });
  const hintEl = h('span', { class: 'dirty-hint' });
  const confirmBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => submit(true) }, '确认执行');
  const cancelBtn = h('button', { class: 'btn danger', type: 'button', onclick: () => submit(false) }, '取消回合');
  const resetBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => reset() }, '撤销编辑');
  const foot = h('div', { class: 'plan-foot' }, hintEl, spacer(), resetBtn, cancelBtn, confirmBtn);

  const body = h('div', { class: 'card-body' }, goalEl, assumBox, questBox, table, foot);
  el.append(head, body);

  const state = { turnId: null, revision: -1, built: false, dirty: false, busy: false, locked: false, rows: [], note: '' };

  /* --------------------------------------------------------------- 构建 */

  function fillRoleOptions(sel, current) {
    const roles = ctx.state.roles || [];
    const want = roles.map((r) => r.id);
    const have = [...sel.options].map((o) => o.value);
    const same = want.length === have.length && want.every((id, i) => id === have[i]);
    if (!same) {
      sel.replaceChildren(...roles.map((r) => h('option', { value: r.id },
        `${r.name || r.id}（${r.id}）${r.available === false ? ' · 不可用' : ''}`)));
    }
    if (current && !(ctx.state.roles || []).some((r) => r.id === current)) {
      sel.append(h('option', { value: current }, `${current}（未在角色表中）`));
    }
    sel.value = current || (roles[0] ? roles[0].id : 'task');
  }

  function makeRow(s) {
    const roleSel = h('select', { class: 'pr-role', title: '改派角色' });
    const roleBadge = h('span', { class: 'role-badge' });
    const titleInput = h('input', { type: 'text', class: 'pr-title', maxlength: '160' });
    const detailArea = h('textarea', { class: 'pr-detail', rows: '3' });
    titleInput.value = s.title || '';
    detailArea.value = s.detail || '';
    fillRoleOptions(roleSel, s.role);

    const flags = h('div', { class: 'pr-flags' });
    const dirty = () => { state.dirty = true; refreshFoot(); };
    titleInput.addEventListener('input', dirty);
    detailArea.addEventListener('input', dirty);
    roleSel.addEventListener('change', () => { updateRoleBadge(roleBadge, roleSel.value); dirty(); });

    const el2 = h('div', { class: 'plan-row', dataset: { st: s.id } },
      h('div', { class: 'pr-id' }, s.id),
      h('div', { class: 'pr-main' }, titleInput, detailArea),
      h('div', { class: 'pr-side' }, roleBadge, roleSel, flags),
    );
    updateRoleBadge(roleBadge, roleSel.value);

    return {
      el: el2, id: s.id, roleSel, titleInput, detailArea, flags, base: s,
      render(plan2) {
        titleInput.value = plan2.title || '';
        detailArea.value = plan2.detail || '';
        fillRoleOptions(roleSel, plan2.role);
        updateRoleBadge(roleBadge, roleSel.value);
        flags.replaceChildren(
          plan2.needs_privilege ? h('span', { class: 'tag' }, '需提权') : null,
          ...(plan2.depends_on || []).map((d) => h('span', { class: 'tag mono' }, `依赖 ${d}`)),
          ...(plan2.inputs || []).map((i) => h('span', { class: 'tag mono' }, `输入 ${i}`)),
          plan2.acceptance ? h('span', { class: 'tag', title: '验收标准' }, `验收：${plan2.acceptance}`) : null,
        );
        this.base = plan2;
      },
      setDisabled(dis) {
        titleInput.disabled = dis;
        detailArea.disabled = dis;
        roleSel.disabled = dis;
      },
    };
  }

  function updateRoleBadge(badge, roleId) {
    if (badge.dataset.role !== roleId) badge.dataset.role = roleId;
    const r = (ctx.state.roles || []).find((x) => x.id === roleId);
    setText(badge, roleName(roleId, ctx.state.roles));
    badge.title = r ? `${r.description || ''}${r.available === false ? `（不可用：${r.note || '未说明原因'}）` : ''}` : '';
    badge.classList.toggle('dim', !!(r && r.available === false));
  }

  function build(plan) {
    setText(goalEl, '');
    goalEl.replaceChildren(h('strong', {}, '目标：'), document.createTextNode(plan.goal || '（未给出目标）'));

    assumBox.replaceChildren(
      h('div', { class: 'plan-section-title' }, `前提假设（${(plan.assumptions || []).length}）`),
      (plan.assumptions || []).length
        ? h('ul', { class: 'plan-list' }, ...plan.assumptions.map((a) => h('li', {}, a)))
        : h('div', { class: 'muted' }, '无'),
    );
    questBox.replaceChildren(
      h('div', { class: 'plan-section-title' }, `待澄清问题（${(plan.questions || []).length}）`),
      (plan.questions || []).length
        ? h('ul', { class: 'plan-list question' }, ...plan.questions.map((q) => h('li', {}, q)))
        : h('div', { class: 'muted' }, '无'),
    );

    state.rows = (plan.subtasks || []).map(makeRow);
    state.rows.forEach((r) => r.render((plan.subtasks || []).find((s) => s.id === r.id) || r.base));
    table.replaceChildren(...state.rows.map((r) => r.el));
    state.dirty = false;
    refreshFoot();
  }

  /* --------------------------------------------------------------- 交互 */

  function refreshFoot() {
    const hint = state.locked
      ? (state.busy ? state.note : '')
      : (state.note || (state.dirty ? '已修改，尚未确认（将按你改过的计划执行）' : ''));
    setText(hintEl, hint);
    resetBtn.disabled = state.locked || state.busy || !state.dirty;
    confirmBtn.disabled = state.locked || state.busy;
    cancelBtn.disabled = state.locked || state.busy;
  }

  function collect() {
    const problems = [];
    const subtasks = state.rows.map((r) => {
      const title = r.titleInput.value.trim();
      const detail = r.detailArea.value.trim();
      const role = r.roleSel.value;
      if (!title) problems.push(`${r.id} 标题不能为空`);
      if (!detail) problems.push(`${r.id} 说明不能为空`);
      if (!ROLE_IDS.includes(role)) problems.push(`${r.id} 角色 ${role} 不在契约的 7 个角色内`);
      let dep = [];
      let inputs = [];
      let acceptance = '';
      let needs = false;
      if (r.base && r.base.id === r.id) {
        dep = r.base.depends_on || [];
        inputs = r.base.inputs || [];
        acceptance = r.base.acceptance || '';
        needs = !!r.base.needs_privilege;
      }
      return { id: r.id, title, detail, role, depends_on: dep, inputs, needs_privilege: needs, acceptance };
    });
    return { problems, plan: { goal: current.goal || goalEl.textContent.replace(/^目标：/, ''), subtasks, assumptions: current.assumptions, questions: current.questions } };
  }
  let current = { assumptions: [], questions: [] };
  let lastTurn = null;

  async function submit(approved) {
    if (state.busy || state.locked) return;
    let plan = null;
    if (approved) {
      const res = collect();
      if (res.problems.length) {
        ctx.toast('error', `计划不合法：${res.problems.slice(0, 3).join('；')}`);
        return;
      }
      plan = res.plan;
      const unavailable = plan.subtasks
        .map((s) => s.role)
        .filter((r) => (ctx.state.roles || []).some((x) => x.id === r && x.available === false));
      if (unavailable.length) {
        ctx.toast('warn', `注意：${[...new Set(unavailable)].join('、')} 当前不可用，后端可能跳过或失败`);
      }
    }
    setBusy(true, approved ? '正在提交确认…' : '正在取消…');
    try {
      await ctx.actions.confirmPlan(state.turnId, approved, plan);
      setBusy(false, '');
      ctx.toast(approved ? 'ok' : 'warn', approved ? '计划已确认，开始执行' : '已请求取消该回合');
    } catch (err) {
      ctx.toast('error', `${approved ? '确认' : '取消'}失败：${err.message}`);
      setBusy(false, '');
    }
  }

  function setBusy(dis, hint) {
    state.busy = dis;
    if (hint !== undefined) state.note = dis ? hint : '';
    refreshFoot();
  }

  function reset() {
    if (state.locked || !lastTurn) return;
    state.dirty = false;
    state.revision = -1;
    state.built = false;
    state.note = '';
    sync(lastTurn);
    state.note = '已恢复到后端给出的原始计划';
    refreshFoot();
  }

  function isLocked(turn) {
    if (turn.planDecision) return true;
    if (turn.doneStage) return true;
    return LOCKED_STAGES.includes(turn.stage);
  }

  /* --------------------------------------------------------------- 同步 */

  function sync(turn) {
    lastTurn = turn;
    const plan = turn.plan;
    el.classList.toggle('hidden', !plan);
    if (!plan) { state.built = false; return; }

    if (state.turnId !== turn.turn_id) {
      state.turnId = turn.turn_id;
      state.revision = -1;
      state.built = false;
      state.dirty = false;
      state.busy = false;
      state.note = '';
    }
    const planChanged = state.revision !== turn.planRevision;
    if (!state.built || (planChanged && !state.dirty)) {
      current = { goal: plan.goal, assumptions: plan.assumptions || [], questions: plan.questions || [] };
      build(plan);
      state.revision = turn.planRevision;
      state.built = true;
    } else {
      current = { ...current, assumptions: plan.assumptions || current.assumptions, questions: plan.questions || current.questions };
      // 角色表可能在计划之后才加载完成，补一次下拉选项
      state.rows.forEach((r) => fillRoleOptions(r.roleSel, r.roleSel.value));
      if (planChanged) state.note = '后端更新了计划内容（你本地已有未提交的修改，保持你的编辑）';
    }

    const locked = isLocked(turn);
    if (locked !== state.locked) {
      state.locked = locked;
      state.rows.forEach((r) => r.setDisabled(locked));
    }
    refreshFoot();

    const total = plan.subtasks.length;
    const priv = plan.subtasks.filter((s) => s.needs_privilege).length;
    setText(goalMeta, `${total} 个子任务${priv ? ` · 其中 ${priv} 个需提权` : ''}`);

    let statusText = '等待你的确认';
    let tone = '';
    if (turn.planDecision === 'approved') { statusText = '已确认'; tone = 'ok'; }
    else if (turn.planDecision === 'rejected' || turn.planDecision === 'cancelled') { statusText = '已取消'; tone = 'bad'; }
    else if (turn.doneStage === 'completed') { statusText = '已确认执行'; tone = 'ok'; }
    else if (turn.doneStage) { statusText = `回合${STAGE_LABEL[turn.doneStage] || turn.doneStage}`; tone = 'bad'; }
    else if (locked) { statusText = `阶段：${STAGE_LABEL[turn.stage] || turn.stage}`; }
    statusTag.className = `tag ${tone}`.trim();
    setText(statusTag, statusText);
    el.dataset.locked = locked ? '1' : '0';
  }

  return { el, sync, get rows() { return state.rows; } };
}
