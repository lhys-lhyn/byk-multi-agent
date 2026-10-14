/**
 * 按角色解析「这次调用该用哪个模型」。
 *
 * 峰谷规则与用户的 switch-dsh-model.ps1 完全一致（见 lib/timing.js）：
 *   高峰 -> xiaomi / mimo-v2.6-flash（不指定 reasoningEffort，与脚本 $script:PeakSelection 一致）
 *   低谷 -> deepseek-official / deepseek-flash，reasoningEffort = high
 * 已用脚本自身的 -Status -Port 1（只读、不碰会话）交叉验证 7 个时刻，全部一致。
 *
 * 切换点在每次调用时求值，不改会话默认模型：不打断用户当前会话、不动他在 UI 里选的模型。
 */
import {
  PEAK_HOURS,
  WEEKEND_VALLEY_FROM_SEC,
  HOLIDAY_VALLEY_FROM_SEC,
  HOLIDAY_VALLEY,
  isPeakTime,
  nextPeakChange,
  describePhase,
} from "./timing.js";
import { readFileSync } from "node:fs";

/** 与 switch-dsh-model.ps1 的 $script:PeakSelection 逐字对应（脚本里高峰不带 effort）。 */
export const SCRIPT_PEAK = { provider: "xiaomi", model: "mimo-v2.6-flash" };
/** 与 $script:OffPeakSelection 逐字对应。 */
export const SCRIPT_OFF_PEAK = {
  provider: "deepseek-official",
  model: "deepseek-flash",
  reasoningEffort: "high",
};

/**
 * backend 的取值域。角色配置里 backend 只能取这四种之一：
 *   llm           —— 拉云端子智能体（默认）
 *   asr           —— 直连语音识别，不经子智能体
 *   local         —— 跑用户自己配的命令/脚本
 *   local-extract —— 调 BYK 自带的本地提取层 byk.extract（文档解析 / OCR / 语音转写），
 *                    全程本地推理，不调用任何 LLM、不需要 API key
 * backend_of 在解析时校验这个集合，写错立刻报错，不会静默落到 llm。
 */
export const BACKENDS = ["llm", "asr", "local", "local-extract"];

/**
 * 逐助手显式覆盖认得的字段。只有这几个字段能把「用户/覆盖层显式写过的」与
 * 「DEFAULT_ROLES 的出厂默认值」区分开 —— 没有这个区分，峰谷路由就没法既保持老行为、
 * 又让逐助手的模型配置压过它（DEFAULT_ROLES 给每个角色都填了 provider/model）。
 */
const OVERRIDE_FIELDS = ["backend", "provider", "model", "reasoningEffort"];

/** 默认角色表。model/provider 是「不参与峰谷切换」或关掉路由时的固定路由。 */
export const DEFAULT_ROLES = {
  task: {
    name: "任务助手",
    description: "把一段诉求拆成可执行的子任务并指派角色",
    backend: "llm",
    provider: SCRIPT_OFF_PEAK.provider,
    model: SCRIPT_OFF_PEAK.model,
    reasoningEffort: SCRIPT_OFF_PEAK.reasoningEffort,
    sandbox: "workspace-write",
    timeoutMs: 1800 * 1000,
  },
  code: {
    name: "代码助手",
    description: "代码审查、缺陷排查、执行命令、构建、部署",
    backend: "llm",
    provider: SCRIPT_OFF_PEAK.provider,
    model: SCRIPT_OFF_PEAK.model,
    reasoningEffort: SCRIPT_OFF_PEAK.reasoningEffort,
    sandbox: "danger-full-access",
    timeoutMs: 3600 * 1000,
  },
  vision: {
    name: "视觉助手",
    description: "图片直读；视频直读（画面 + 音轨）",
    backend: "llm",
    provider: "xiaomi",
    model: "mimo-v2.6-flash",
    sandbox: "workspace-write",
    timeoutMs: 1800 * 1000,
  },
  file: {
    name: "文件助手",
    description: "Word / PPT / PDF / Excel 内容提取与结构化",
    backend: "llm",
    provider: "xiaomi",
    model: "mimo-v2.6-flash",
    sandbox: "workspace-write",
    timeoutMs: 1800 * 1000,
  },
  audio: {
    name: "语音助手",
    description: "语音转写、整理与信息提炼",
    // 直连 ASR：DSH/pi-ai 没有音频通路，mimo-v2.5-asr 只能按 input_audio 报文直连调用。
    backend: "asr",
    provider: "xiaomi",
    model: "mimo-v2.5-asr",
    asr: {
      baseURL: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-asr",
      apiKeyEnv: "XIAOMI_API_KEY",
    },
    // 转写之后是否再让 chat 模型整理/理解；设成 null 就只回转写原文。
    understand: { provider: "xiaomi", model: "mimo-v2.6-flash" },
    sandbox: "workspace-write",
    timeoutMs: 1200 * 1000,
  },
  research: {
    name: "科研助手",
    description: "科研问题分析、文献检索、成果综述",
    backend: "llm",
    provider: "xiaomi",
    // 用户要求：科研助手固定用 mimo-v2.6-pro（不跟随峰谷），literature 综述值得用最强的。
    // 它同时在全局 forbiddenModels 里，所以这里按角色开白名单——**只有这一个角色**能越过该条禁用，
    // mimo-v2.6-pro-ultraspeed 不在任何白名单里，仍然全局全禁。
    model: "mimo-v2.6-pro",
    allowForbiddenModels: ["mimo-v2.6-pro"],
    sandbox: "workspace-write",
    timeoutMs: 2700 * 1000,
  },
  search: {
    name: "搜索助手",
    description: "检索资料并汇总成带出处的信息",
    backend: "llm",
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    sandbox: "workspace-write",
    timeoutMs: 1800 * 1000,
  },
};

/** 默认配置。别人复制 agents.config.example.json 改名成 agents.config.json 即可覆盖。 */
export const DEFAULT_CONFIG = {
  routing: {
    enabled: true,
    appliesTo: ["task", "code", "search"],
    peak: { ...SCRIPT_PEAK },
    offPeak: { ...SCRIPT_OFF_PEAK },
    peakHours: PEAK_HOURS.map((h) => [...h]),
    weekendValleyFromSec: WEEKEND_VALLEY_FROM_SEC,
    holidayValleyFromSec: HOLIDAY_VALLEY_FROM_SEC,
    holidays: [...HOLIDAY_VALLEY],
  },
  /** 角色模型的权威来源："routing"=本文件（默认，开箱即用）；"registry"=BYK 的 roles.py（老行为，改完下次调用生效）。 */
  rolesFrom: "routing",
  roles: DEFAULT_ROLES,
  /**
   * 硬拦：这些模型名一律不许出现在解析结果里。
   * mimo-v2.6-pro-ultraspeed = mimo-v2.6-pro 开 20x 速度，单价最贵，用户明确禁用。
   */
  forbiddenModels: ["deepseek-v4-pro", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"],
  /** 本地处理后端（可选）：不配就用大模型。 */
  local: { enabled: false, command: "", args: [], timeoutMs: 600 * 1000 },
  /**
   * 本地提取层（backend: "local-extract"）：走 BYK 自带的 byk.extract，全程本地推理
   * （pypdf / python-docx / python-pptx / openpyxl / rapidocr-onnxruntime / faster-whisper），
   * 不调用任何大模型、不需要 API key、不需要网络。
   *   command     留空 = 用 <python> -m byk.cli extract；给了就用它（args 支持 {pathsFile}/{cwd}）。
   *   python      留空 = 用插件配置里的 python。
   *   whisperModel/ocrLang 透传给 byk.cli extract。
   * 默认 enabled: true —— 只有把某个角色的 backend 显式设成 local-extract 才会走到这里，
   * 所以打开它不会改变任何角色的既有行为；关掉它则让 local-extract 角色明确报错。
   */
  localExtract: {
    enabled: true,
    command: "",
    args: [],
    python: "",
    whisperModel: "small",
    ocrLang: "ch",
    timeoutMs: 600 * 1000,
  },
};

/** 读一份 JSON 配置；文件不存在或坏了就返回 {}（插件不该因为一个坏配置起不来）。 */
export function loadConfigFile(filePath) {
  if (!filePath) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== "object" || typeof patch !== "object") return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) out[key] = deepMerge(base[key], patch[key]);
  return out;
}

/**
 * 逐字段记下「用户配置里显式写了什么」。
 * 只在**用户传进来的那份配置**上算，所以重复 resolveConfig 不会把默认值误当成显式配置：
 * 已解析过的配置自带 roleOverrides，原样透传。
 */
function collectRoleOverrides(userRoles) {
  const out = {};
  if (!userRoles || typeof userRoles !== "object" || Array.isArray(userRoles)) return out;
  for (const [id, patch] of Object.entries(userRoles)) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
    const fields = {};
    for (const f of OVERRIDE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== undefined) fields[f] = true;
    }
    if (Object.keys(fields).length) out[id] = fields;
  }
  return out;
}

/** 默认值 + 用户配置（agents.config.json 或插件 config 段）。 */
export function resolveConfig(userConfig) {
  const user = userConfig || {};
  const merged = deepMerge(DEFAULT_CONFIG, user);
  const roles = {};
  for (const [id, role] of Object.entries(merged.roles || {})) {
    roles[id] = deepMerge(DEFAULT_ROLES[id] || {}, role);
  }
  merged.roles = roles;
  merged.roleOverrides = user.roleOverrides && typeof user.roleOverrides === "object"
    ? user.roleOverrides
    : collectRoleOverrides(user.roles);
  return merged;
}

function assertAllowed(route, config, role) {
  const banned = config.forbiddenModels || [];
  const allowedForRole = (role && role.allowForbiddenModels) || [];
  if (banned.includes(route.model) && !allowedForRole.includes(route.model)) {
    throw new Error('forbidden model "' + route.model + '"（禁用名单：' + banned.join("、") + '）');
  }
  return route;
}

/**
 * 逐助手显式覆盖 —— 当前优先级最高的一层。
 *
 * 顺序契约（s4 定稿，设置页 s5 依赖它）：
 *   覆盖层 > agents.config.json 的 roles.<id> > 峰谷 > DEFAULT_ROLES 基准
 *   - 覆盖层 = <bykRoot>/byk/assistants.local.json。调用方要把**原始覆盖层对象**放在
 *     options.overlay 传进来，而不是合并后的注册表：合并后的注册表分不出「roles.py 的出厂值」
 *     和「用户改过的值」，全都会看着像显式配置。
 *   - agents.config.json 的 roles.<id> 只认 OVERRIDE_FIELDS 里**显式写过**的字段。
 *   - 覆盖里只写 model 不写 provider 时，provider 沿用下一层解析出来的值；两个都写才是完整的一对。
 * @param roleId 角色 id。
 * @param config 已经过 resolveConfig 的配置。
 * @param overlay 覆盖层对象（可为 null）。
 * @returns null（没有覆盖）或 {provider?, model?, backend?, reasoningEffort?, from:"overlay"|"config"}
 */
function roleOverrideOf(roleId, config, overlay) {
  const out = {};
  let from = "";
  const cfgFields = (config.roleOverrides && config.roleOverrides[roleId]) || null;
  const role = config.roles[roleId] || {};
  if (cfgFields) {
    for (const f of OVERRIDE_FIELDS) {
      // 空串不算「显式配置」：agents.config.json 里写 "" 应该等同于没写，沿用下一层。
      if (cfgFields[f] && role[f] !== undefined && role[f] !== "") out[f] = role[f];
    }
    if (Object.keys(out).length) from = "config";
  }
  const patch = overlay && typeof overlay === "object" && overlay.roles
    && typeof overlay.roles === "object" ? overlay.roles[roleId] : null;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    let touched = false;
    for (const f of OVERRIDE_FIELDS) {
      if (patch[f] !== undefined && patch[f] !== null && patch[f] !== "") {
        out[f] = patch[f];
        touched = true;
      }
    }
    if (touched) from = "overlay";
  }
  return from ? { ...out, from } : null;
}

/** 这次用哪个后端：显式覆盖 > 角色自己的 backend > llm。写错立刻报错，不静默落到 llm。 */
function backendOf(role, override) {
  const backend = (override && override.backend) || role.backend || "llm";
  if (!BACKENDS.includes(backend)) {
    throw new Error('未知 backend "' + backend + '"（可用：' + BACKENDS.join("、") + '）');
  }
  return backend;
}

/**
 * 覆盖层新增的角色在 agents.config.json 里没有 roles.<id> 条目，resolveRoute 直接抛
 * 「未知角色」会让人没法用设置页新增助手。这里用注册表元数据兜一个最小角色：
 * **只有注册表给了 model 才兜**，否则返回 null，让原来的「未知角色」报错逐字照旧。
 */
function roleFromRegistry(roleId, registry) {
  const entry = registry && typeof registry === "object" ? registry[roleId] : null;
  if (!entry || typeof entry !== "object" || !entry.model) return null;
  return {
    name: entry.name,
    description: entry.description,
    backend: entry.backend || "llm",
    provider: entry.provider || "",
    model: entry.model,
    sandbox: entry.sandbox,
    timeoutMs: entry.timeout_s ? entry.timeout_s * 1000 : undefined,
  };
}

/**
 * 解析一个角色这一次调用该走的模型。
 * options: { now, config, registry, overlay }（registry 是 byk.cli roles --json 的原始表，
 * 用来补 persona/sandbox/超时；overlay 是 assistants.local.json 的原始对象，用来做逐助手覆盖）
 */
export function resolveRoute(roleId, options) {
  const o = options || {};
  const config = o.config ? resolveConfig(o.config) : resolveConfig();
  const role = config.roles[roleId] || roleFromRegistry(roleId, o.registry);
  if (!role) {
    throw new Error('unknown role "' + roleId + '"（可用：' + Object.keys(config.roles).join("、") + '）');
  }
  if (role.enabled === false) throw new Error('role "' + roleId + '" 已被禁用');

  const entry = o.registry && o.registry[roleId] ? o.registry[roleId] : null;
  // 逐助手显式覆盖（最高优先级）：覆盖层 > agents.config.json 的 roles.<id>。
  const override = roleOverrideOf(roleId, config, o.overlay);
  const now = o.now === undefined ? Math.floor(Date.now() / 1000) : o.now;
  const timingOptions = {
    peakHours: config.routing.peakHours,
    weekendValleyFromSec: config.routing.weekendValleyFromSec,
    holidayValleyFromSec: config.routing.holidayValleyFromSec,
    holidays: config.routing.holidays,
  };

  let provider = role.provider;
  let model = role.model;
  let reasoningEffort = role.reasoningEffort;
  let source = "role";
  // describeEffectiveRoute 用的新词表（"role-override" | "peak" | "off-peak" | "default"）。
  // 旧的 source 字段（role / registry / routing.peak / routing.off-peak）逐字保持不变，
  // 老调用方与老测试不受影响 —— 新词表只加字段、不改字段。
  let sourceKind = "default";

  if (config.rolesFrom === "registry" && entry && entry.model) {
    provider = entry.provider || provider;
    model = entry.model;
    source = "registry";
  }

  let phase = null;
  const routed = config.routing.enabled !== false && (config.routing.appliesTo || []).includes(roleId);
  if (routed) {
    const peak = isPeakTime(now, timingOptions);
    const pick = peak ? config.routing.peak : config.routing.offPeak;
    provider = pick.provider;
    model = pick.model;
    // 高峰不带 effort 就**不要**下发（与脚本一致：它切到高峰时会删掉 reasoningEffort 行）。
    reasoningEffort = pick.reasoningEffort;
    phase = peak ? "peak" : "off-peak";
    source = "routing." + phase;
    sourceKind = phase;
  }

  // ① 逐助手显式覆盖**压过**峰谷路由：这是本次新增的优先级，也是设置页改完立刻生效的那一层。
  //    峰谷不再参与这次解析 —— phase 置空，formatRoute 才不会把它写成「高峰」。
  //    只写了 model 没写 provider 时，provider 沿用下一层解析出来的值（两个都写才是完整的一对）。
  if (override) {
    if (override.provider !== undefined) provider = override.provider;
    if (override.model !== undefined) model = override.model;
    if (override.reasoningEffort !== undefined) reasoningEffort = override.reasoningEffort;
    source = override.from === "overlay" ? "overlay" : "role";
    sourceKind = "role-override";
    phase = null;
  }

  // ② 非 LLM 后端不进模型路由。本地提取层尤其不能挂着云端模型的名字：它的 model 标识
  //    由**实际走的库**决定，index.js 拿到提取结果后用 localModelLabel 覆盖成
  //    "local:rapidocr-onnxruntime" 这类。这里先给一个诚实的占位。
  const backend = backendOf(role, override);
  if (backend === "local-extract") {
    provider = "local";
    model = "local:extract";
    reasoningEffort = undefined;
    sourceKind = "local-extract";
  } else if (backend === "local") {
    sourceKind = "local";
  } else if (backend === "asr") {
    sourceKind = "asr";
  }

  return assertAllowed(
    {
      roleId,
      backend,
      provider,
      model,
      reasoningEffort,
      sandbox: (entry && entry.sandbox) || role.sandbox,
      timeoutMs: (entry && entry.timeout_s ? entry.timeout_s * 1000 : 0) || role.timeoutMs,
      persona: entry ? entry.persona_subagent || entry.persona : role.persona,
      asr: role.asr,
      understand: role.understand,
      local: role.local,
      localExtract: role.localExtract,
      phase,
      source,
      sourceKind,
      routed: routed && !override,
      nextChange: routed && !override ? nextPeakChange(now, timingOptions) : null,
      described: describePhase(now, timingOptions),
    },
    config,
    role,
  );
}

/** 本地后端：把 {task}/{cwd} 占位符填好，返回可直接 spawn 的命令。 */
export function resolveLocalCommand(roleId, options) {
  const o = options || {};
  const config = o.config ? resolveConfig(o.config) : resolveConfig();
  const role = config.roles[roleId];
  if (!role) throw new Error('unknown role "' + roleId + '"');
  const local = deepMerge(config.local || {}, role.local || {});
  if (local.enabled === false) {
    throw new Error('本地后端未启用：请在 agents.config.json 里设 local.enabled = true（或 roles.' + roleId + '.local.enabled = true）');
  }
  if (!local.command) throw new Error('本地后端缺少 command：请配置 local.command / roles.' + roleId + '.local.command');
  const fill = (t) => String(t).replace(/\{task\}/g, o.task || "").replace(/\{cwd\}/g, o.cwd || process.cwd());
  return { command: fill(local.command), args: (local.args || []).map(fill), cwd: local.cwd, timeoutMs: local.timeoutMs };
}

/**
 * 本地提取层（backend: "local-extract"）：把「待提取的绝对路径」拼成一条命令。
 *
 * 只拼命令，**不跑进程、不写文件** —— 路径清单文件由调用方（lib/index.js）落盘，
 * 于是这个函数保持纯函数，test/routing-local.test.js 可以只喂普通对象就覆盖它。
 * 路径统一走 --paths-file（每行一个绝对路径），避开 Windows 命令行长度上限。
 *
 * @param roleId 角色 id。
 * @param options {config, python, pathsFile, cwd}
 *   python    —— 插件配置里的解释器（localExtract.command 留空时用它起 byk.cli extract）。
 *   pathsFile —— 已经落盘的路径清单文件绝对路径（必填）。
 * @returns {command, args, cwd, timeoutMs, pathsFile}
 */
export function resolveLocalExtractCommand(roleId, options) {
  const o = options || {};
  const config = o.config ? resolveConfig(o.config) : resolveConfig();
  const role = config.roles[roleId];
  if (!role) throw new Error('unknown role "' + roleId + '"');
  const local = deepMerge(config.localExtract || {}, role.localExtract || {});
  if (local.enabled === false) {
    throw new Error("本地提取层未启用：请在 agents.config.json 里设 localExtract.enabled = true" +
      "（或 roles." + roleId + ".localExtract.enabled = true）");
  }
  const pathsFile = String(o.pathsFile || "");
  if (!pathsFile) {
    throw new Error("本地提取层需要 pathsFile：待提取路径要先落成一个清单文件（每行一个），" +
      "避免命令行长度上限");
  }
  if (local.command) {
    const fill = (t) => String(t)
      .replace(/\{pathsFile\}/g, pathsFile)
      .replace(/\{cwd\}/g, o.cwd || process.cwd());
    return {
      command: fill(local.command),
      args: (local.args || []).map(fill),
      cwd: local.cwd,
      timeoutMs: local.timeoutMs,
      pathsFile,
    };
  }
  const python = String(local.python || o.python || "");
  if (!python) {
    throw new Error("本地提取层缺少 python：请给插件配置 python（<bykRoot>/.venv/Scripts/python.exe），" +
      "或设 localExtract.python");
  }
  return {
    command: python,
    args: [
      "-m", "byk.cli", "extract", "--json", "--paths-file", pathsFile,
      "--whisper-model", String(local.whisperModel || "small"),
      "--ocr-lang", String(local.ocrLang || "ch"),
    ],
    cwd: local.cwd,
    timeoutMs: local.timeoutMs,
    pathsFile,
  };
}

/** 解析结果 -> "provider/model effort=high ｜高峰"。 */
export function formatRoute(route) {
  if (route.backend === "local") return "本地后端";
  if (route.backend === "asr") return "直连 ASR " + route.model + (route.understand ? " → " + route.understand.model : "");
  if (route.backend === "local-extract") return "本地提取层 byk.extract（不调用任何 LLM）";
  let text = route.provider + "/" + route.model;
  if (route.reasoningEffort) text += " effort=" + route.reasoningEffort;
  if (route.phase) text += " ｜" + (route.phase === "peak" ? "高峰" : "低谷");
  else text += route.sourceKind === "role-override" ? " ｜逐助手覆盖" : " ｜固定路由";
  return text;
}

/**
 * 一个角色「这次实际会用哪个模型/后端」——设置页（s5）直接拿它做展示。
 *
 * 与 resolveRoute 的区别：resolveRoute 是执行路径（要拿 provider/model 去起子智能体），
 * 这个函数是**只读描述**，把来源说清楚，且从不开进程、不写文件。
 *
 * @param roleId 角色 id。
 * @param options {now, config, registry, overlay} —— 与 resolveRoute 完全相同。
 * @returns {roleId, backend, provider, model, reasoningEffort, sandbox, timeoutMs,
 *           phase, routed, source, sourceDetail, text, summary}
 *   source（新词表）：
 *     "role-override"           逐助手显式配置（覆盖层或 agents.config.json 的 roles 段）
 *     "peak" | "off-peak"       峰谷路由
 *     "default"                 DEFAULT_ROLES 基准（该角色不参与峰谷）
 *     "local" | "local-extract" | "asr"  后端不是云端 LLM，不参与模型路由
 *   sourceDetail：resolveRoute 原有的 source 字段（role / registry / routing.peak /
 *     routing.off-peak / overlay），给「到底哪来的」留一条可追溯的线索。
 *   text：与 formatRoute 逐字相同，可直接显示。
 *   summary：一句人话来源说明。
 */
export function describeEffectiveRoute(roleId, options) {
  const route = resolveRoute(roleId, options);
  const source = routeSourceOf(route);
  return {
    roleId: route.roleId,
    backend: route.backend,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    sandbox: route.sandbox,
    timeoutMs: route.timeoutMs,
    phase: route.phase,
    routed: route.routed,
    source,
    sourceDetail: route.source,
    text: formatRoute(route),
    summary: sourceSummary(source, route),
  };
}

/** 把解析结果归到 describeEffectiveRoute 的新词表上。 */
function routeSourceOf(route) {
  if (route.backend === "local-extract") return "local-extract";
  if (route.backend === "local") return "local";
  if (route.backend === "asr") return "asr";
  if (route.sourceKind === "role-override") return "role-override";
  if (route.phase === "peak" || route.phase === "off-peak") return route.phase;
  return "default";
}

/** 每个来源的一句话说明，设置页直接显示。 */
const SOURCE_SUMMARY = {
  "role-override": "逐助手显式配置（覆盖层 assistants.local.json，或 agents.config.json 的 roles 段）：压过峰谷路由。",
  peak: "峰谷路由：当前是高峰，跟随 routing.peak。",
  "off-peak": "峰谷路由：当前是低谷，跟随 routing.offPeak。",
  default: "角色基准（DEFAULT_ROLES）：这个角色不参与峰谷路由，走固定路由。",
  local: "本地后端：跑配置好的命令，不经过任何模型。",
  "local-extract": "本地提取层 byk.extract：本地推理（文档解析 / OCR / 语音转写），不调用任何 LLM。",
  asr: "直连语音识别：不经过子智能体；understand 配了才会再叫 chat 模型整理。",
};

function sourceSummary(source, route) {
  const base = SOURCE_SUMMARY[source] || "";
  return route.source ? base + "（source=" + route.source + "）" : base;
}
