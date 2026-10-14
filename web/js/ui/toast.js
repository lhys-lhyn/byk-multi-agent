import { h } from '../util.js';

/** 右下角轻量提示 */
export function createToaster(root) {
  return function toast(kind, text, ms = 4500) {
    if (!text) return;
    const el = h('div', { class: 'toast', dataset: { kind: kind || 'info' } }, text);
    root.append(el);
    setTimeout(() => el.remove(), ms);
  };
}
