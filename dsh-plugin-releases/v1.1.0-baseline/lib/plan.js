/**
 * 计划层：把「任务助手」产出的结构化计划变成可校验、可排序、可并发执行的数据。
 *
 * 纯逻辑，不依赖 DSH 运行时，可单独测试：node test/plan.test.js
 */

/** 七个助手 id（与 lib/index.js、BYK roles.py 一致） */
export const ROLE_IDS = ["task", "code", "vision", "file", "audio", "research", "search"];

/** 角色中文名（用于计划书与进度行的可读展示） */
export const ROLE_LABEL = {
  task: "任务助手",
  code: "代码助手",
  vision: "视觉助手",
  file: "文件助手",
  audio: "语音助手",
  research: "科研助手",
  search: "搜索助手",
};

const FENCE = String.fromCharCode(96).repeat(3); // 三连反引号

/** 交给任务助手的规划指令：只允许输出一个 JSON 对象。 */
export const PLAN_INSTRUCTION = [
  "你现在扮演「任务助手」：把用户的诉求拆成可执行的子任务计划，并为每一条指派执行角色。",
  "",
  "只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。结构如下：",
  "{",
  '  "goal": "一句话总目标",',
  '  "steps": [',
  "    {",
  '      "id": "s1",',
  '      "title": "短标题",',
  '      "role": "code",',
  '      "task": "自包含的任务说明：背景、要做什么、涉及的绝对路径、交付物形态",',
  '      "acceptance": "怎样算完成（可验证）",',
  '      "depends_on": [],',
  '      "estimate_min": 10',
  "    }",
  "  ],",
  '  "notes": "可选：风险、需要用户先提供的东西"' ,
  "}",
  "",
  "硬性要求：",
  "- role 只能是这七个之一：" + ROLE_IDS.join("、") + "。",
  "- steps 数量 2~8 条；能并行的步骤不要互相 depends_on。",
  "- depends_on 里只能写本计划其它步骤的 id；没有依赖就写 []。",
  "- task 必须自包含：执行者看不到用户原话，所有文件用绝对路径。",
  "- 你只是规划者：不要自己执行、不要调用任何工具。",
].join("\n");

function tryJson(s) {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch (err) { return { ok: false, error: String(err && err.message) }; }
}

/** 从模型输出里找第一个括号平衡的 JSON 对象（跳过字符串里的括号）。 */
function extractBalanced(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * 从助手回复里解析计划 JSON。容错顺序：整体就是 JSON > 代码围栏 > 第一个平衡对象。
 * @returns {{ok: boolean, plan: object|null, error: string, raw: string}}
 */
export function parsePlan(text) {
  const raw = String(text == null ? "" : text);
  const direct = tryJson(raw.trim());
  if (direct.ok) return { ok: true, plan: direct.value, error: "", raw };
  const fenceRe = new RegExp(FENCE + "(?:json)?\\s*([\\s\\S]*?)" + FENCE, "i");
  const fence = fenceRe.exec(raw);
  if (fence) {
    const f = tryJson(fence[1].trim());
    if (f.ok) return { ok: true, plan: f.value, error: "", raw };
  }
  const balanced = extractBalanced(raw);
  if (balanced) {
    const b = tryJson(balanced);
    if (b.ok) return { ok: true, plan: b.value, error: "", raw };
  }
  return { ok: false, plan: null, error: "没能在助手输出里找到合法的 JSON 计划对象。", raw };
}

/** 找循环依赖：返回参与环的步骤 id。 */
function findCycles(steps) {
  const ids = steps.map((s) => s.id);
  let remaining = new Set(ids);
  let guard = 0;
  for (;;) {
    if (guard++ > ids.length + 2) break;
    const free = steps.filter((s) => remaining.has(s.id) && s.depends_on.every((d) => !remaining.has(d)));
    if (!free.length) break;
    for (const s of free) remaining.delete(s.id);
  }
  return [...remaining];
}

/**
 * 校验并规范化计划：补 id、纠正非法角色、清理悬空/自引用依赖、检测环。
 * @returns {{plan: {goal: string, steps: object[], notes: string}, problems: string[]}}
 */
export function normalizePlan(input, options) {
  const opts = options || {};
  const roles = Array.isArray(opts.roles) && opts.roles.length ? opts.roles : ROLE_IDS;
  const maxSteps = Number(opts.maxSteps) > 0 ? Number(opts.maxSteps) : 12;
  const problems = [];
  const src = input && typeof input === "object" ? input : {};
  const goal = String(src.goal == null ? "" : src.goal).trim();
  if (!goal) problems.push("计划里没有 goal。");
  const rawSteps = Array.isArray(src.steps) ? src.steps.slice(0, maxSteps) : [];
  if (!rawSteps.length) problems.push("计划里没有 steps。");
  if (Array.isArray(src.steps) && src.steps.length > maxSteps) problems.push("步骤数超过上限 " + maxSteps + "，已截断。");

  const steps = [];
  const seen = new Set();
  rawSteps.forEach((s, i) => {
    const it = s && typeof s === "object" ? s : {};
    let id = String(it.id == null ? "" : it.id).trim() || "s" + (i + 1);
    while (seen.has(id)) id = id + "-" + (i + 1);
    seen.add(id);
    let role = String(it.role == null ? "" : it.role).trim().toLowerCase();
    if (!roles.includes(role)) {
      problems.push("步骤 " + id + " 的角色「" + (role || "(空)") + "」不认识，已改为 task。");
      role = "task";
    }
    const title = String(it.title == null ? "" : it.title).trim();
    const task = String(it.task == null ? "" : it.task).trim();
    if (!task) problems.push("步骤 " + id + " 没有 task，已用标题兜底。");
    const acceptance = String(it.acceptance == null ? "" : it.acceptance).trim();
    const deps = Array.isArray(it.depends_on)
      ? it.depends_on.map((x) => String(x == null ? "" : x).trim()).filter(Boolean)
      : [];
    const est = Number(it.estimate_min);
    const step = { id, title: title || id, role, task: task || title || id, acceptance, depends_on: deps };
    if (Number.isFinite(est) && est > 0) step.estimate_min = Math.round(est);
    steps.push(step);
  });

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const before = s.depends_on.length;
    s.depends_on = [...new Set(s.depends_on.filter((d) => d !== s.id && ids.has(d)))];
    if (s.depends_on.length !== before) problems.push("步骤 " + s.id + " 的依赖里有未知或自引用项，已忽略。");
  }
  const cyclic = findCycles(steps);
  if (cyclic.length) {
    problems.push("检测到循环依赖：" + cyclic.join("、") + "（环内依赖已忽略，按就绪顺序执行）。");
    for (const s of steps) if (cyclic.includes(s.id)) s.depends_on = s.depends_on.filter((d) => !cyclic.includes(d));
  }
  return { plan: { goal, steps, notes: String(src.notes == null ? "" : src.notes).trim() }, problems };
}

/**
 * 按依赖拓扑分批：同层步骤之间无依赖，可并发；层内按 maxParallel 切块。
 * @returns {{batches: object[][], blocked: string[]}}
 */
export function planBatches(plan, options) {
  const opts = options || {};
  const maxParallel = Math.max(1, Number(opts.maxParallel) || 3);
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const done = new Set();
  let remaining = [...steps];
  const batches = [];
  let guard = 0;
  while (remaining.length && guard++ <= steps.length + 2) {
    let ready = remaining.filter((s) => s.depends_on.every((d) => done.has(d)));
    if (!ready.length) ready = [remaining[0]]; // 兜底：异常依赖也不至于卡死
    for (let i = 0; i < ready.length; i += maxParallel) batches.push(ready.slice(i, i + maxParallel));
    for (const s of ready) done.add(s.id);
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  return { batches, blocked: steps.map((s) => s.id).filter((id) => !done.has(id)) };
}

/** 计划里所有步骤的预计总耗时（分钟）；没有预计值的步骤不计入。 */
export function totalEstimate(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  return steps.reduce((sum, s) => sum + (Number(s.estimate_min) > 0 ? Number(s.estimate_min) : 0), 0);
}

function oneLine(s, max) {
  const t = String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const limit = max || 160;
  return t.length > limit ? t.slice(0, limit - 1) + "…" : t;
}

/** 给用户看的计划书（可直接贴进回复里确认）。 */
export function formatPlanText(plan, problems) {
  const lines = [];
  lines.push("【执行计划】" + (plan.goal ? plan.goal : "(未给出总目标)"));
  const est = totalEstimate(plan);
  lines.push("共 " + plan.steps.length + " 步" + (est > 0 ? "，预计合计 " + est + " 分钟（并发执行会更短）" : ""));
  lines.push("");
  plan.steps.forEach((s, i) => {
    const label = ROLE_LABEL[s.role] || s.role;
    lines.push((i + 1) + ". [" + s.id + "] " + label + "（" + s.role + "）— " + oneLine(s.title, 80));
    if (s.depends_on.length) lines.push("   依赖：" + s.depends_on.join("、"));
    if (s.estimate_min) lines.push("   预计：" + s.estimate_min + " 分钟");
    if (s.acceptance) lines.push("   验收：" + oneLine(s.acceptance, 120));
    lines.push("   任务：" + oneLine(s.task));
  });
  if (plan.notes) lines.push("", "备注：" + oneLine(plan.notes, 300));
  if (problems && problems.length) {
    lines.push("", "【需要留意】");
    for (const p of problems) lines.push("- " + p);
  }
  lines.push("", "确认执行请回复「执行」；要改派角色、增删步骤或调整顺序，直接说。");
  return lines.join("\n");
}

/** 一行进度（状态/百分比/预计完成都用它，不编造数字）。 */
export function formatProgressText(done, total, note) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return "进度 " + done + "/" + total + "（" + pct + "%）" + (note ? " ｜ " + note : "");
}
