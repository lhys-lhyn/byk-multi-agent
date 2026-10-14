/* 回合时间线：按契约顺序渲染
   用户输入块 → 提取结果块 → 阶段进度 → 计划卡片 → 子任务卡片 → 汇总卡片（+ 错误块）
   所有卡片按 key 复用，重复 sync / 重连对齐都不会产生重复节点。 */

import { h } from '../util.js';
import {
  createUserBlock, createExtractBlock, createStageBlock,
  createSummaryBlock, createErrorBlock, createWaitingBlock,
} from './blocks.js';
import { createPlanCard } from './plan-card.js';
import { createSubtaskCard } from './subtask-card.js';

const PLANNING_STAGES = ['intake', 'extracting', 'planning'];

export function createTimeline({ ctx, root }) {
  const cards = new Map();
  const emptyEl = h('div', { class: 'empty' },
    '还没有回合。在下方输入需求（可拖入文件）后发送，或用 ?mock=1 打开离线演示。');
  root.append(emptyEl);

  function get(key, factory) {
    let c = cards.get(key);
    if (!c) { c = factory(); cards.set(key, c); }
    return c;
  }

  function sync(turn) {
    if (!turn) {
      for (const c of cards.values()) c.el.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    const order = [];

    // 1) 用户输入块
    const user = get('user', () => createUserBlock());
    user.sync(turn);
    order.push('user');

    // 2) 提取结果块
    const extract = get('extract', () => createExtractBlock());
    extract.sync(turn);
    extract.el.classList.toggle('hidden', !(turn.extractions.length || turn.stage === 'extracting'));
    order.push('extract');

    // 3) 阶段进度
    const stage = get('stage', () => createStageBlock());
    stage.sync(turn);
    order.push('stage');

    // 3.5) 规划中的占位
    const waiting = get('waiting', () => createWaitingBlock());
    waiting.sync(turn);
    waiting.el.classList.toggle('hidden', !(PLANNING_STAGES.includes(turn.stage) && !turn.plan));
    order.push('waiting');

    // 4) 计划卡片
    const plan = get('plan', () => createPlanCard({ ctx }));
    plan.sync(turn);
    order.push('plan');

    // 5) 子任务卡片（按 store 顺序，即计划顺序）
    for (const st of turn.subtasks) {
      const key = `st:${st.id}`;
      const c = get(key, () => createSubtaskCard({ ctx, id: st.id }));
      c.sync(turn);
      c.el.classList.remove('hidden');
      order.push(key);
    }

    // 6) 汇总卡片
    const summary = get('summary', () => createSummaryBlock());
    summary.sync(turn);
    summary.el.classList.toggle('hidden', turn.summary === null || turn.summary === undefined);
    order.push('summary');

    // 7) 错误块
    const err = get('error', () => createErrorBlock());
    err.sync(turn);
    err.el.classList.toggle('hidden', !turn.error);
    order.push('error');

    // 清理已经不在回合里的子任务卡片
    const keep = new Set(order);
    for (const [k, c] of [...cards]) {
      if (k.startsWith('st:') && !keep.has(k)) { c.el.remove(); cards.delete(k); }
    }

    // 按顺序排布 DOM（只在顺序真的不同的时候才移动）
    const visible = order.map((k) => cards.get(k).el).filter((el) => !el.classList.contains('hidden'));
    let idx = 1;                        // 0 号是 emptyEl
    for (const el of visible) {
      const cur = root.children[idx];
      if (cur !== el) root.insertBefore(el, cur || null);
      idx += 1;
    }
  }

  /** 每 500ms 让 running 中的卡片刷新实时耗时 */
  function tick() {
    for (const c of cards.values()) if (c.tick) c.tick();
  }

  function scrollToBottom() { root.scrollTop = root.scrollHeight; }

  return { sync, tick, scrollToBottom, cards };
}
