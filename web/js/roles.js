/* 7 个角色（契约 §0）的静态兜底表；真实数据来自 GET /api/roles。
   徽标配色由 styles.css 中 [data-role=...] 提供（契约 §6 末）。 */

export const ROLE_IDS = ['task', 'code', 'vision', 'file', 'audio', 'research', 'search'];

export const ROLE_FALLBACK = [
  { id: 'task', name: '任务助手', model: 'deepseek-v4-flash', available: true,
    description: '识别文本中的任务、拆成子任务、指派角色，产出结构化计划', note: '' },
  { id: 'code', name: '代码助手', model: 'deepseek-v4-flash', available: true,
    description: '代码审查、查 bug、执行命令、部署、计算机相关一切', note: '' },
  { id: 'vision', name: '视觉助手', model: '—', available: false,
    description: '图片/视频内容理解', note: '当前无可用支持图像输入的 provider' },
  { id: 'file', name: '文件助手', model: 'deepseek-v4-flash', available: true,
    description: 'Word/PPT/PDF 等文件内容提取', note: '' },
  { id: 'audio', name: '语音助手', model: 'deepseek-v4-flash', available: true,
    description: '语音转文字并理解', note: '' },
  { id: 'research', name: '研究助手', model: 'deepseek-v4-flash', available: true,
    description: '科研问题、文献检索、研究思路', note: '' },
  { id: 'search', name: '搜索助手', model: 'deepseek-v4-flash', available: true,
    description: '一切与问题相关的资料检索', note: '' },
];

const ROLE_NAME = new Map(ROLE_FALLBACK.map((r) => [r.id, r.name]));

/** 角色中文名：优先用 /api/roles 的 name，缺失时用兜底表，再缺失就原样显示 id */
export function roleName(id, roles = []) {
  const found = roles.find((r) => r && r.id === id);
  if (found && found.name) return found.name;
  return ROLE_NAME.get(id) || String(id || '未知');
}

/** 合并后端角色表与兜底表：以契约的 7 个 id 为准，顺序固定 */
export function mergeRoles(remote) {
  const byId = new Map((Array.isArray(remote) ? remote : []).map((r) => [r && r.id, r]));
  return ROLE_IDS.map((id) => {
    const base = ROLE_FALLBACK.find((r) => r.id === id);
    const got = byId.get(id) || {};
    return {
      id,
      name: got.name || base.name,
      model: got.model || base.model,
      available: typeof got.available === 'boolean' ? got.available : base.available,
      description: got.description || base.description,
      note: got.note || '',
      extra: Object.keys(got).filter((k) => !['id', 'name', 'model', 'available', 'description', 'note'].includes(k)),
    };
  });
}
