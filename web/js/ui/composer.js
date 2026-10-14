/* 输入区（契约 §6 第 1 项）：多行文本 + 拖拽/选择文件（可见附件 chips）+ 发送 */

import { h, setText, fmtBytes, KIND_LABEL } from '../util.js';

const guessKind = (name = '') => {
  const ext = String(name).toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'flac', 'ogg'].includes(ext)) return 'audio';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
  if (['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'xml'].includes(ext)) return 'text';
  return 'unknown';
};

export function createComposer({ ctx, root }) {
  const files = [];
  let busy = false;

  const ta = h('textarea', {
    id: 'composer-text',
    rows: '3',
    placeholder: '描述你的需求，例如：帮我看下 server.log 为什么 8080 端口启动失败（可拖入文件）…',
    oninput: () => autoGrow(),
    onkeydown: (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    },
  });

  const chips = h('div', { class: 'chips hidden' });
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden', onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  const dropHint = h('div', { class: 'composer-hint' }, '把文件拖到这里，或点右侧「选择文件」添加附件');
  const dz = h('div', { class: 'dropzone' }, ta, chips, dropHint);

  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  const pickBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => fileInput.click() }, '选择文件');
  const sendBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => send() }, '发送');
  const hint = h('span', { class: 'composer-hint' });
  const actions = h('div', { class: 'composer-actions' },
    pickBtn, fileInput, hint, h('span', { style: { flex: '1 1 auto' } }), sendBtn);

  root.append(h('div', { class: 'composer-inner' }, dz, actions));

  setText(hint, ctx.state.mode === 'mock'
    ? 'mock 模式：附件不会真正上传，发送后回放一段脚本事件'
    : 'Ctrl+Enter 发送 · 文件随 multipart/form-data 一起 POST /api/turns');

  function autoGrow() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(220, Math.max(62, ta.scrollHeight))}px`;
  }

  function addFiles(list) {
    for (const f of list) {
      if (files.some((x) => x.name === f.name && x.size === f.size)) continue;
      files.push(f);
    }
    renderChips();
  }

  function renderChips() {
    chips.classList.toggle('hidden', files.length === 0);
    chips.replaceChildren(...files.map((f, i) => h('span', { class: 'chip' },
      h('span', { class: 'chip-name', title: f.name }, f.name),
      h('span', { class: 'chip-meta' }, `${KIND_LABEL[guessKind(f.name)] || '未知'} · ${fmtBytes(f.size)}`),
      h('button', { class: 'chip-x', type: 'button', title: '移除', onclick: () => { files.splice(i, 1); renderChips(); } }, '×'),
    )));
  }

  async function send() {
    if (busy) return;
    const text = ta.value.trim();
    if (!text && !files.length) {
      ctx.toast('warn', '请输入需求文本，或至少添加一个附件');
      ta.focus();
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    setText(sendBtn, '发送中…');
    try {
      await ctx.actions.createTurn({ text, files: files.slice() });
      ta.value = '';
      files.length = 0;
      renderChips();
      autoGrow();
    } catch (err) {
      ctx.toast('error', `发送失败：${err.message}`);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      setText(sendBtn, '发送');
    }
  }

  function sync() {
    setText(hint, ctx.state.mode === 'mock'
      ? 'mock 模式：附件不会真正上传，发送后回放一段脚本事件'
      : 'Ctrl+Enter 发送 · 文件随 multipart/form-data 一起 POST /api/turns');
  }

  return { sync, focus: () => ta.focus() };
}
