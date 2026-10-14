/* mock 后端：实现与 HttpBackend 完全相同的接口，但由 web/mock/replay.js 的脚本回放事件。
   目标：不启动真实后端（byk/server.py）也能完整演示并验证前端。
   开启方式：index.html?mock=1 ；截图锚点：?mock=1&at=plan|running|privilege|done ；速度：&speed=fast
*/

import { buildReplay } from '../mock/replay.js';
import { nowIso, confirmationBody } from './util.js';

/** 锚点别名：文档里写的是 privilege-need-secret，内部步 id 是 privilege-secret，两个都能用 */
const ANCHOR_ALIAS = {
  'privilege-need-secret': 'privilege-secret',
  'need-secret': 'privilege-secret',
  'secret': 'privilege-secret',
};

const ASSETS = {
  roles: '../mock/roles.json',
  precedents: '../mock/precedents.json',
  plan: '../mock/plan.json',
  confirmation: '../mock/confirmation.json',
  turn: '../mock/turn.json',
  extractions: '../mock/extractions.json',
  turns: '../mock/turns.json',
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guessKind(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
  if (['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'xml'].includes(ext)) return 'text';
  return 'unknown';
}

export class MockBackend {
  constructor({ store, params }) {
    this.store = store;
    this.params = params || new URLSearchParams();
    this.at = ANCHOR_ALIAS[this.params.get('at') || ''] || this.params.get('at') || '';
    this.speed = this.params.get('speed') || 'normal';
    this.data = null;
    this.turns = new Map();
    this.order = [];
    this.handlers = null;
    this.abort = true;
    this.step = null;
    this.gateResolvers = {};
    this.gateDecisions = {};
    this.branch = 'approved';
    this.seq = 0;
    this.session = 's_mock_live';
    this.onStep = null;
    this.onSubmit = null;          // 每次收到"提权确认提交"时回调（带上与 HttpBackend 同一个构造函数产出的 body）
    this.submits = [];             // 收到的全部提权确认提交（断言用）
    this.frozen = false;
  }

  async init() {
    const entries = await Promise.all(Object.entries(ASSETS).map(async ([k, rel]) => {
      const url = new URL(rel, import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`无法加载 mock 资源 ${rel}（HTTP ${res.status}）`);
      return [k, await res.json()];
    }));
    this.data = Object.fromEntries(entries);

    // 预置历史回合（左栏"会话/回合"列表）
    for (const t of this.data.turns) {
      this.turns.set(t.turn_id, {
        turn_id: t.turn_id, session_id: t.session_id, created_at: t.created_at,
        user_text: t.user_text, attachments: [], stage: t.stage,
        extractions: [], plan: null, subtasks: [], summary: t.stage === 'completed' ? '（历史回合，mock 模式仅保留摘要占位）' : null,
        error: t.stage === 'failed' ? '提取层：两个 PDF 的页数不一致，无法逐页对齐（mock 占位）' : null,
        pending_confirmation: null,
      });
      this.order.push(t.turn_id);
    }
    return this;
  }

  /* ------------------------------------------------------------ REST 等价 */

  async health() { return { ok: true, version: '1-mock' }; }

  async roles() { return clone(this.data.roles); }

  async precedents() { return clone(this.data.precedents); }

  async listTurns() {
    return this.order
      .map((id) => this.turns.get(id))
      .filter(Boolean)
      .map((t) => ({
        turn_id: t.turn_id, session_id: t.session_id, created_at: t.created_at,
        user_text: t.user_text, stage: t.stage,
      }));
  }

  async getTurn(turnId) {
    const t = this.turns.get(turnId);
    if (!t) throw new Error(`mock 中没有回合 ${turnId}`);
    return clone(t);                       // 与真实后端一致：完整快照（用于重连对齐）
  }

  async createTurn({ text, files = [], sessionId = null }) {
    const tpl = this.data.turn;
    this.seq += 1;
    const turnId = `t_mock_${String(this.seq).padStart(4, '0')}x`;
    const sid = sessionId || this.session;
    const snap = clone(tpl);
    snap.turn_id = turnId;
    snap.session_id = sid;
    snap.created_at = nowIso();
    snap.user_text = (text || '').trim() || tpl.user_text;
    snap.attachments = files.length
      ? files.map((f, i) => ({
          id: `a${i + 1}`,
          name: f.name,
          kind: guessKind(f.name),
          size: f.size,
          path: `（浏览器上传，mock 模式不会真的落盘）${f.name}`,
        }))
      : clone(tpl.attachments);
    snap.stage = 'intake';
    this.turns.set(turnId, snap);
    this.order.push(turnId);
    return { session_id: sid, turn_id: turnId };
  }

  async confirmPlan(turnId, approved, plan) {
    const snap = this.turns.get(turnId);
    if (!approved) {
      if (snap) snap.stage = 'cancelled';
      this.resolveGate('plan', { approved: false });
      return { ok: true };
    }
    if (plan) {
      this.live.plan = clone(plan);
      this.rebuildSubs();
      if (snap) snap.plan = clone(plan);
    }
    if (snap) snap.stage = 'executing';
    this.resolveGate('plan', { approved: true });
    return { ok: true };
  }

  async cancelTurn(turnId) {
    const snap = this.turns.get(turnId);
    this.abort = true;
    if (snap) { snap.stage = 'cancelled'; snap.pending_confirmation = null; }
    this.handlers?.onEvent('done', { turn_id: turnId, stage: 'cancelled' });
    return { ok: true };
  }

  /**
   * 契约 §5：secret_ref 为可选字段，省略或 null 时沿用先例绑定的引用。
   * mock 把它记下来，回放里据此决定 st_3 是"能执行"还是"fail closed 受阻"。
   */
  async confirmPrivilege(cid, approved, remember, secretRef) {
    const snap = this.currentSnapshot;
    if (snap && snap.pending_confirmation?.id === cid) snap.pending_confirmation = null;
    const ref = typeof secretRef === 'string' && secretRef.trim() ? secretRef.trim() : null;
    if (this.live) this.live.secretRef = ref;
    this.lastDecision = { cid, approved: !!approved, remember: !!remember, secretRef: ref };
    // 用**与 HttpBackend 完全相同**的构造函数记录"实际收到的提交体"，
    // 这样在 mock 模式下也能断言线上格式（用户没填时 secret_ref 键应完全不出现）
    const body = confirmationBody(approved, remember, secretRef);
    this.lastSubmit = { cid, body };
    this.submits.push(this.lastSubmit);
    this.onSubmit?.(body, cid);
    this.resolveGate(this.pendingGate || 'privilege-1', { approved: !!approved, secretRef: ref });
    return { ok: true };
  }

  /* ------------------------------------------------------------- 事件流 */

  subscribe(turnId, handlers) {
    this.stop();
    this.handlers = handlers;
    this.abort = false;
    this.branch = 'approved';
    this.frozen = false;
    this.gateResolvers = {};
    this.gateDecisions = {};
    this.pendingGate = null;
    this.lastDecision = null;
    const snap = this.turns.get(turnId);
    if (!snap) { handlers.onError?.(new Error(`mock 中没有回合 ${turnId}`)); return () => {}; }
    this.currentSnapshot = snap;

    const built = buildReplay({
      turn: snap,
      plan: this.data.plan,
      confirmations: this.data.confirmation,     // mock/confirmation.json：两个样本（requires_secret false / true）
      extractions: this.data.extractions,
    });
    this.live = built.live;
    this.rebuildSubs = built.rebuildSubs;

    handlers.onOpen?.();
    this.play(built.steps, turnId).catch((err) => {
      console.error('[mock] 回放异常', err);
      handlers.onError?.(err);
    });
    return () => this.stop();
  }

  stop() {
    this.abort = true;
    this.handlers = null;
  }

  async play(steps, turnId) {
    const auto = this.at !== '';
    const freezeIdx = auto ? steps.findIndex((s) => s.id === this.at) : -1;
    if (auto && freezeIdx < 0) console.warn(`[mock] 未知锚点 at=${this.at}`);

    for (let i = 0; i < steps.length; i += 1) {
      if (this.abort) return;
      const s = steps[i];
      if (s.branch && s.branch !== this.branch) continue;
      if (s.needs && !this.live.subs[s.needs]) continue;
      const isFreeze = auto && i === freezeIdx;

      if (s.gate) {
        if (auto) {
          // 截图/自动模式：闸门直接按"批准"通过。
          // requireSecret 的闸门用一个"弹层里建议的引用名"模拟用户填写，
          // 这样 ?mock=1&at=done 展示的是全部成功的终态（真实交互里的留空路径由验证脚本单独覆盖）。
          if (s.gate === 'plan') await this.confirmPlan(turnId, true, null);
          else await this.confirmPrivilege(s.confirmationId, true, false, s.requireSecret ? 'PRECEDENT_SVC_ACCOUNT_PW' : null);
          if (isFreeze) {
            // at=privilege / at=privilege-secret：停在"弹层正显示"的这一刻，便于截图验证
            this.frozen = true;
            this.onStep?.({ step: this.step, index: i, total: steps.length, frozen: true, anchor: this.at });
            return;
          }
          if (String(s.gate).startsWith('privilege')) {
            // 自动模式没有真实点击事件，补发一次快照让界面收掉提权弹层（快照里已清空）
            this.handlers?.onEvent('snapshot', clone(this.turns.get(turnId)));
          }
        } else {
          const d = await this.waitGate(s.gate);
          if (!d || !d.approved) {
            this.branch = s.rejectBranch || (s.gate === 'plan' ? 'plan-cancelled' : 'privilege-rejected');
            if (s.gate === 'plan') {
              this.applyToSnapshot(turnId, 'done', { stage: 'cancelled' });
              this.handlers?.onEvent('done', { turn_id: turnId, stage: 'cancelled' });
              return;
            }
          } else if (s.missingSecretBranch && s.requireSecret && !d.secretRef) {
            // 批准了，但用户没补密钥引用 → 走 fail-closed 分支
            this.branch = s.missingSecretBranch;
          }
        }
      }

      if (s.event) {
        const delay = auto ? 0 : this.scale(s.delay || 0);
        if (delay > 0) await sleep(delay);
        if (this.abort) return;
        const data = typeof s.data === 'function' ? s.data() : s.data;
        if (data) {
          this.applyToSnapshot(turnId, s.event, data);
          this.handlers?.onEvent(s.event, data);
          if (s.gateHint) this.pendingGate = s.gateHint;     // 下一个闸门是谁（弹层里点按钮时要用）
          this.step = s.id || s.event;
          this.onStep?.({ step: this.step, index: i, total: steps.length, frozen: false });
        }
      }

      if (isFreeze) {
        this.frozen = true;
        this.onStep?.({ step: this.step, index: i, total: steps.length, frozen: true, anchor: this.at });
        return;
      }
    }
    this.onStep?.({ step: 'end', index: steps.length, total: steps.length, frozen: false });
  }

  scale(ms) {
    if (this.speed === 'fast') return Math.round(ms * 0.3);
    if (this.speed === 'slow') return Math.round(ms * 2);
    return ms;
  }

  waitGate(name) {
    if (name in this.gateDecisions) {
      const d = this.gateDecisions[name];
      delete this.gateDecisions[name];
      return Promise.resolve(d);
    }
    this.pendingGate = name;
    return new Promise((resolve) => { this.gateResolvers[name] = resolve; });
  }

  resolveGate(name, decision) {
    const r = this.gateResolvers[name];
    if (r) { delete this.gateResolvers[name]; r(decision); }
    else this.gateDecisions[name] = decision;
  }

  /** 让 GET /api/turns/{id} 的返回与已投递的事件一致（模拟真实后端的快照） */
  applyToSnapshot(turnId, event, data) {
    const snap = this.turns.get(turnId);
    if (!snap) return;
    switch (event) {
      case 'stage': snap.stage = data.stage || snap.stage; break;
      case 'extraction': snap.extractions.push(clone(data.extraction)); break;
      case 'plan': snap.plan = clone(data.plan); break;
      case 'subtask': {
        const st = clone(data.subtask);
        const idx = snap.subtasks.findIndex((x) => x.id === st.id);
        if (idx >= 0) snap.subtasks[idx] = st; else snap.subtasks.push(st);
        break;
      }
      case 'confirmation': snap.pending_confirmation = clone(data.confirmation); break;
      case 'summary': snap.summary = data.summary; break;
      case 'error': snap.error = data.message || '未知错误'; break;
      case 'done': snap.stage = data.stage; snap.pending_confirmation = null; break;
      case 'agent_delta': break;  // 与真实后端一致：流式增量不写入快照
      default: break;
    }
  }
}
