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

/** 默认值 + 用户配置（agents.config.json 或插件 config 段）。 */
export function resolveConfig(userConfig) {
  const merged = deepMerge(DEFAULT_CONFIG, userConfig || {});
  const roles = {};
  for (const [id, role] of Object.entries(merged.roles || {})) {
    roles[id] = deepMerge(DEFAULT_ROLES[id] || {}, role);
  }
  merged.roles = roles;
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
 * 解析一个角色这一次调用该走的模型。
 * options: { now, config, registry }（registry 是 byk.cli roles --json 的原始表，用来补 persona/sandbox/超时）
 */
export function resolveRoute(roleId, options) {
  const o = options || {};
  const config = o.config ? resolveConfig(o.config) : resolveConfig();
  const role = config.roles[roleId];
  if (!role) {
    throw new Error('unknown role "' + roleId + '"（可用：' + Object.keys(config.roles).join("、") + '）');
  }
  if (role.enabled === false) throw new Error('role "' + roleId + '" 已被禁用');

  const entry = o.registry && o.registry[roleId] ? o.registry[roleId] : null;
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
  }

  return assertAllowed(
    {
      roleId,
      backend: role.backend || "llm",
      provider,
      model,
      reasoningEffort,
      sandbox: (entry && entry.sandbox) || role.sandbox,
      timeoutMs: (entry && entry.timeout_s ? entry.timeout_s * 1000 : 0) || role.timeoutMs,
      persona: entry ? entry.persona_subagent || entry.persona : role.persona,
      asr: role.asr,
      understand: role.understand,
      local: role.local,
      phase,
      source,
      nextChange: routed ? nextPeakChange(now, timingOptions) : null,
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

/** 解析结果 -> "provider/model effort=high ｜高峰"。 */
export function formatRoute(route) {
  if (route.backend === "local") return "本地后端";
  if (route.backend === "asr") return "直连 ASR " + route.model + (route.understand ? " → " + route.understand.model : "");
  let text = route.provider + "/" + route.model;
  if (route.reasoningEffort) text += " effort=" + route.reasoningEffort;
  text += route.phase ? " ｜" + (route.phase === "peak" ? "高峰" : "低谷") : " ｜固定路由";
  return text;
}
