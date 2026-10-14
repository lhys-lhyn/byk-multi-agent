/* 提权确认弹层（契约 §6 第 5 项 / §5 Confirmation）
   展示 title / reason / command_preview / risk，并提供「批准」「拒绝」。
   幂等：同一个 confirmation.id 只构建一次，用户勾选状态不会被重连重放冲掉。 */

import { h, setText, fmtClock, RISK_LABEL } from '../util.js';

export function createConfirmModal({ ctx, root }) {
  let el = null;
  let currentId = null;
  let built = null;
  let remember = false;
  let busy = false;

  function close() {
    if (el) { el.remove(); el = null; }
    built = null;
    currentId = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && built) { ev.preventDefault(); decide(false); }
  }

  async function decide(approved) {
    if (!built || busy) return;
    // 先把要用到的引用/文本抓成本地变量：提交过程中 store 会清掉 pending_confirmation，
    // 触发 modal.sync → close() 把 built 置空，这里不能再依赖 built。
    const t = {
      turnId: built.turnId,
      cid: built.cid,
      shortTitle: built.shortTitle,
      busyEl: built.busyEl,
      approveBtn: built.approveBtn,
      rejectBtn: built.rejectBtn,
      requiresSecret: built.requiresSecret,
      secretInput: built.secretInput,
    };
    // 只有批准时才提交 secret_ref；留空则完全不提交该字段（契约 §5：省略即沿用先例绑定的引用）
    const secretRef = approved && t.secretInput ? t.secretInput.value.trim() : '';
    busy = true;
    t.approveBtn.disabled = true;
    t.rejectBtn.disabled = true;
    setText(t.busyEl, approved ? '正在提交批准…' : '正在提交拒绝…');
    try {
      await ctx.actions.decideConfirmation(t.turnId, t.cid, approved, approved ? remember : false, secretRef || undefined);
      ctx.toast(approved ? 'ok' : 'warn', approved
        ? `已批准提权：${t.shortTitle}`
        : `已拒绝提权：${t.shortTitle}`);
      if (approved && t.requiresSecret && !secretRef) {
        ctx.toast('warn', '已批准，但没有提供密钥引用：该命令含 {{secret}} 占位符，后端很可能仍无法执行', 9000);
      }
      close();
    } catch (err) {
      if (built) {
        built.approveBtn.disabled = false;
        built.rejectBtn.disabled = false;
        setText(built.busyEl, '');
      }
      busy = false;
      ctx.toast('error', `提交失败：${err.message}`);
    }
  }

  function build(turn, c) {
    const precedent = (ctx.state.precedents || []).find((p) => p.id === c.precedent_id) || null;
    // 契约 §5：requires_secret=true 表示命令含 {{secret}} 但没绑定密钥引用 —— 必须显式呈现
    const requiresSecret = c.requires_secret === true;
    const title = h('h2', { class: 'modal-title' }, c.title || '需要提权才能继续');

    const approveBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => decide(true) }, '批准');
    const rejectBtn = h('button', { class: 'btn danger', type: 'button', onclick: () => decide(false) }, '拒绝');
    const busyEl = h('span', { class: 'muted' });

    const cmd = h('pre', { class: 'cmd-preview' }, c.command_preview || '（后端未提供命令预览）');

    const secretInput = h('input', {
      type: 'text',
      id: 'confirm-secret',
      class: 'secret-input',
      placeholder: '例如 PRECEDENT_SVC_ACCOUNT_PW',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const rememberBox = h('input', {
      type: 'checkbox',
      id: 'confirm-remember',
      onchange: (e) => { remember = e.target.checked; },
    });

    const body = h('div', { class: 'modal-body' },
      requiresSecret ? h('div', { class: 'confirm-warning', id: 'confirm-warning' },
        h('span', { class: 'cw-icon' }, '⚠'),
        h('div', { class: 'cw-text' },
          h('strong', {}, '缺少密钥引用：现在批准也无法执行'),
          h('p', {}, c.secret_source || '该命令包含 {{secret}} 占位符，但没有匹配到任何已绑定的密钥引用。'),
          h('p', { class: 'cw-sub' }, '后端已把本确认的风险提升为「高」。请在下方补充密钥引用后再批准；留空则沿用先例绑定的引用，而本次没有可用先例。'),
        )) : null,
      h('div', { class: 'kv' },
        h('div', { class: 'kv-k' }, '操作'),
        h('div', { class: 'kv-v' }, c.title || '—'),
        h('div', { class: 'kv-k' }, '原因'),
        h('div', { class: 'kv-v' }, c.reason || '—'),
        h('div', { class: 'kv-k' }, '风险等级'),
        h('div', { class: 'kv-v' },
          h('span', { class: 'risk-badge', dataset: { risk: c.risk || 'unknown' } }, RISK_LABEL[c.risk] || `未知（${c.risk || '未给出'}）`)),
        h('div', { class: 'kv-k' }, '需要密钥'),
        h('div', { class: 'kv-v' },
          requiresSecret
            ? h('span', { class: 'tag crit' }, '缺密钥引用（requires_secret=true）')
            : h('span', { class: 'tag ok' }, '已绑定')),
        h('div', { class: 'kv-k' }, '密钥引用'),
        h('div', { class: 'kv-v mono' }, c.secret_ref || '—'),
        h('div', { class: 'kv-k' }, '匹配先例'),
        h('div', { class: 'kv-v mono' }, c.precedent_id || '—'),
        h('div', { class: 'kv-k' }, '所属回合'),
        h('div', { class: 'kv-v mono' }, c.turn_id || turn.turn_id),
        h('div', { class: 'kv-k' }, '所属子任务'),
        h('div', { class: 'kv-v mono' }, c.subtask_id || '—'),
      ),
      h('div', { class: 'plan-section-title' }, '将要执行的命令（预览）'),
      cmd,
      requiresSecret
        ? h('div', { class: 'secret-row' },
          h('label', { class: 'kv-k', for: 'confirm-secret' }, '补充密钥引用（可选）'),
          secretInput,
          h('div', { class: 'secret-hint' }, '只填引用名（例如 PRECEDENT_SVC_ACCOUNT_PW），不要填明文口令；明文由本地密钥库解析，密钥值永不回显。留空则随批准提交时不带 secret_ref。'),
        )
        : (c.secret_source ? h('div', { class: 'secret-note' }, c.secret_source) : null),
      precedent ? h('div', { class: 'precedent' },
        h('div', { class: 'pc-top' },
          h('span', { class: 'pc-title' }, `先例 ${precedent.id}：${precedent.title}`),
          h('span', { class: 'pc-count' }, `已成功 ${precedent.success_count ?? 0} 次`),
        ),
        h('div', { class: 'pc-kw' },
          ...(precedent.match_keywords || []).map((k) => h('span', { class: 'tag' }, k))),
        h('div', { class: 'pc-cmd' }, precedent.command_template || ''),
        h('div', { class: 'pc-meta' },
          `密钥引用：${precedent.secret_ref || '—'} · 最近使用：${fmtClock(precedent.last_used_at) || '—'}`),
      ) : null,
      h('div', { class: 'muted' }, '密钥明文永不回显；批准后由编排器以特权身份执行该命令，助手进程本身不提权。'),
      h('label', { class: 'checkbox-row', for: 'confirm-remember' }, rememberBox, '记住此决定（后续同类操作可作为先例复用）'),
    );

    const modal = h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('span', { class: 'modal-kind' }, c.kind === 'privilege' ? '提权确认' : `确认（${c.kind || 'unknown'}）`),
        requiresSecret ? h('span', { class: 'modal-kind crit' }, '缺密钥引用') : null,
        title,
      ),
      body,
      h('div', { class: 'modal-foot' },
        h('span', { class: 'muted' }, '按 Esc 等同拒绝'),
        h('span', { class: 'spacer' }),
        busyEl,
        rejectBtn,
        approveBtn,
      ),
    );

    el = h('div', { class: 'modal-backdrop' }, modal);
    root.append(el);
    rejectBtn.focus();                       // 安全默认：焦点在「拒绝」上
    document.addEventListener('keydown', onKey);
    return {
      turnId: c.turn_id || turn.turn_id,
      cid: c.id,
      approveBtn,
      rejectBtn,
      busyEl,
      requiresSecret,
      secretInput: requiresSecret ? secretInput : null,
      shortTitle: (c.title || '').slice(0, 24),
    };
  }

  /** 每次状态变化调用；c 为 turn.pending_confirmation */
  function sync(turn) {
    const c = turn ? turn.pending_confirmation : null;
    if (!c || !c.id) { if (el) close(); return; }
    if (el && currentId === c.id) return;     // 幂等：同一确认不重建（保留勾选状态）
    close();
    currentId = c.id;
    remember = false;
    busy = false;
    built = build(turn, c);
  }

  return { sync, close, get currentId() { return currentId; } };
}
