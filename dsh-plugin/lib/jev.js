/**
 * Jev（TypeSafe SystemOne）调用层 —— key 解析、HTTP 调用、超时、错误归一化、结果压缩。
 *
 * 为什么 BYK 自己发 HTTP，而不是复用宿主已装的 dsh-plugin-jev 工具：见 readme.md
 * 「byk_judge：为什么自己发 HTTP」。一句话：插件之间没有"调用对方工具"的通道——
 * ctx.tools 上注册的工具是给**模型**看的；要在流程内部拿判定，走宿主工具就得再花一次
 * 子智能体 turn 的模型请求，而 BYK 的规划/验收阶段要做的是大量小判定。这里直接发 HTTP，
 * 零额外 turn。
 *
 * 接口契约来源：docs/jev-planning-spec.md（含 3 次真实调用取证）。要点：
 *   - POST <baseUrl>，Authorization: Bearer <key>，Content-Type: application/json
 *   - 请求体 { state, model, questions }，questions 的键由调用方自定、不参与推理
 *   - 响应 { model, answers, usage }
 *   - 校验失败实测 HTTP 400（官方文档写 422），detail 是**字符串**
 *   - 鉴权失败 HTTP 401，detail 是**对象**（error_type/message）
 *
 * 本模块不 import 任何宿主包（只有 node: 内置），因此可以在纯 node 下直测：
 *     node test/jev.test.js
 */
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** TypeSafe 官方 SystemOne 端点。 */
export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";

/** 官方推荐的模型别名；服务端实际版本在响应 model 字段回报（实测 jev-1.13.0）。 */
export const DEFAULT_MODEL = "jev-latest";

/** 默认超时（毫秒）。参考实现 dsh-plugin-jev 同款默认值。 */
export const DEFAULT_TIMEOUT_MS = 60000;

/** 支持的判定类型：noul=是/否概率，choice=多选一，score=有序分级。 */
export const QUESTION_TYPES = ["noul", "choice", "score"];

/** lib/ 的上一级 = 插件目录（C:\Projects\byk\dsh-plugin）。 */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** 判定失败的类型标签，工具返回里以 error_kind 呈现，便于调用方分流。 */
export const ERROR_KINDS = [
  "config",     // 配置/凭据问题：key 缺失、类型不合法、criteria 形状不对
  "invalid",    // HTTP 400/422：请求体被服务端拒绝
  "auth",       // HTTP 401/403：key 无效
  "rate_limit", // HTTP 429
  "overloaded", // HTTP 529
  "server",     // 其他 5xx
  "http",       // 其他非 2xx
  "timeout",    // 自己这边的 AbortController 触发
  "aborted",    // 调用方（exec.signal）取消
  "network",    // 连不上/DNS/TLS 等
  "parse",      // 响应不是合法 JSON，或 answers 里没有对应键
];

/** 判定层错误。kind 取 ERROR_KINDS 之一。 */
export class JevError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

/**
 * 把一次网络失败的**完整原因链**摊平成一行。
 *
 * 为什么需要它：undici（Node 内建 fetch）把真因藏在 \`cause\` 里 —— 外层统一是
 * \`TypeError: fetch failed\`，真正有用的 \`connect ECONNREFUSED 127.0.0.1:7897\` 在
 * \`err.cause\`。只取 \`err.message\` 的话，宿主 .env 里的代理一挂，用户看到的就只有
 * 「Jev 请求失败：fetch failed」，完全分不清是 DNS、TLS、超时还是代理端口没人听。
 * 2026-10-15 就是这么被坑了一整轮：真因在 cause 里躺了一整天。
 *
 * 兼容：多地址并发失败时 undici 会包一层 AggregateError（\`err.errors\`）；
 * cause 自引用用 seen 去重，不会死循环。
 */
export function errorChainText(err) {
  const seen = new Set();
  const parts = [];
  const visit = (e) => {
    if (!e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const name = typeof e.name === "string" && e.name && e.name !== "Error" ? e.name + ": " : "";
    const msg = typeof e.message === "string" ? e.message : String(e);
    const bits = [];
    if (typeof e.code === "string" && e.code) bits.push(e.code);
    const addr = e.address || (e.cause && typeof e.cause === "object" ? e.cause.address : "");
    if (addr) bits.push(String(addr) + (e.port ? ":" + e.port : ""));
    let one = (name + msg).trim();
    if (bits.length && !bits.every((b) => one.includes(b))) one += " [" + bits.join(" ") + "]";
    if (one) parts.push(one);
    if (e.cause) visit(e.cause);
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub);
  };
  visit(err);
  return parts.length ? parts.join(" ← ") : String((err && err.message) || err || "未知网络错误");
}

/** 常见网络失败的一句话处置提示。纯字符串匹配，不猜。 */
export function networkHint(text) {
  const s = String(text || "");
  if (/ECONNREFUSED/.test(s)) {
    return "（连接被拒绝：目标端口没有服务在监听。若这是宿主 .env 里的 HTTPS_PROXY/HTTP_PROXY，" +
      "说明代理没在运行 —— 启动 Clash 之类，或用 C:\\Projects\\dsh\\proxy-watch 的自动跟随方案）";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(s)) return "（DNS 解析失败：检查网络，或代理是否拦了解析）";
  if (/ETIMEDOUT|ECONNRESET|socket hang up/i.test(s)) return "（连接超时/被重置：代理链路中断或对端不可达）";
  if (/CERT|TLS|SSL/i.test(s)) return "（TLS 证书问题：可能是代理在做中间人）";
  return "";
}

/** 截断长文本，避免把整段响应体塞进工具结果。 */
export function truncateText(text, limit) {
  const s = String(text == null ? "" : text);
  const n = Number(limit) > 0 ? Number(limit) : 600;
  return s.length <= n ? s : s.slice(0, n) + "…（已截断，共 " + s.length + " 字符）";
}

/**
 * key 的候选**文件**位置，按优先级排列。纯函数：只算路径，不读文件。
 *
 * 顺序（对照 docs/jev-planning-spec.md 第 1 节，并把显式配置提到隐式猜测之前）：
 *   1. config.jev.keyPath（显式指定，最优先）
 *   2. <DSH_HOME>/profiles/jev.key
 *   3. <插件目录>/../../jev.key      —— 参考实现 dsh-plugin-jev 的 KEY_FILES[0]
 *   4. <DSH_HOME>/profiles/<DSH_PROFILE>/jev.key —— 宿主插件在本机实际生效的位置
 *   5. <DSH_HOME>/jev.key
 *   6. <插件目录>/key.txt            —— 参考实现的 KEY_FILES[1]
 *
 * @param config 插件 config.jev 段
 * @param deps   { env, pluginDir } 注入点；env 默认取 process.env
 * @returns 去重后的绝对路径数组
 */
export function keyFileCandidates(config, deps) {
  const d = deps || {};
  const env = d.env || (typeof process !== "undefined" ? process.env : {}) || {};
  const dir = d.pluginDir || PLUGIN_DIR;
  const home = String(env.DSH_HOME || "").trim();
  const profile = String(env.DSH_PROFILE || "").trim();
  const out = [];
  const push = (p) => {
    const v = p ? String(p) : "";
    if (v && !out.includes(v)) out.push(v);
  };
  if (config && config.keyPath) push(config.keyPath);
  if (home) push(join(home, "profiles", "jev.key"));
  push(join(dir, "..", "..", "jev.key"));
  if (home && profile) push(join(home, "profiles", profile, "jev.key"));
  if (home) push(join(home, "jev.key"));
  push(join(dir, "key.txt"));
  return out;
}

/**
 * 解析 API key。
 *
 * 顺序：config.jev.apiKey → 环境变量 TYPESAFE_API_KEY → 环境变量 JEV_API_KEY
 *      → keyFileCandidates() 里的文件（逐个 existsSync + readFileSync + trim）。
 * 全部拿不到就抛 JevError("config")，**错误文本里点名它找过的每一个位置**，不静默降级。
 *
 * @param config 插件 config.jev 段
 * @param deps   { env, existsSync, readFileSync, pluginDir } 注入点，便于测试桩替换
 * @returns { key, source }  source 是给人看的位置说明
 */
export function resolveApiKey(config, deps) {
  const d = deps || {};
  const env = d.env || (typeof process !== "undefined" ? process.env : {}) || {};
  const exists = d.existsSync || fsExistsSync;
  const read = d.readFileSync || fsReadFileSync;
  const cfg = config || {};

  if (cfg.apiKey && String(cfg.apiKey).trim()) {
    return { key: String(cfg.apiKey).trim(), source: "config.jev.apiKey" };
  }
  if (env.TYPESAFE_API_KEY && String(env.TYPESAFE_API_KEY).trim()) {
    return { key: String(env.TYPESAFE_API_KEY).trim(), source: "环境变量 TYPESAFE_API_KEY" };
  }
  if (env.JEV_API_KEY && String(env.JEV_API_KEY).trim()) {
    return { key: String(env.JEV_API_KEY).trim(), source: "环境变量 JEV_API_KEY" };
  }

  const tried = [];
  for (const p of keyFileCandidates(cfg, d)) {
    let text = null;
    try {
      if (exists(p)) text = read(p, "utf8");
    } catch (err) {
      // 文件存在但读不了（权限/编码）：记下来继续找，别让一个坏文件掩盖后面的好文件。
      tried.push("文件 " + p + "（读取失败：" + String((err && err.message) || err) + "）");
      continue;
    }
    if (text && String(text).trim()) {
      return { key: String(text).trim(), source: "文件 " + p };
    }
    tried.push("文件 " + p);
  }

  const where = [
    "config.jev.apiKey",
    "环境变量 TYPESAFE_API_KEY",
    "环境变量 JEV_API_KEY",
    ...tried,
  ].join(" → ");
  throw new JevError(
    "config",
    "Jev API key 未配置：已依次查找 " + where + "，都没有取到非空值。" +
    "请把 key 写进 config.jev.apiKey、config.jev.keyPath 指向的文件，或上述任一位置。",
  );
}

/** HTTP 状态码 → 错误类型标签。400 与 422 都归到 invalid（文档写 422、实测 400，别把状态码当判据写死）。 */
export function statusKind(status) {
  const s = Number(status);
  if (s === 401 || s === 403) return "auth";
  if (s === 400 || s === 422) return "invalid";
  if (s === 429) return "rate_limit";
  if (s === 529) return "overloaded";
  if (s >= 500) return "server";
  return "http";
}

const KIND_HINT = {
  auth: "（鉴权失败：检查 key 是否有效/过期）",
  invalid: "（请求体被服务端拒绝：检查 question_type 与 criteria 形状）",
  rate_limit: "（限流：请退避后重试）",
  overloaded: "（服务过载：请稍后重试）",
  server: "（服务端错误：可稍后重试）",
  http: "",
};

/**
 * 把非 2xx 响应归一化成 { kind, status, error }。纯函数。
 *
 * 错误体 detail 可能是**字符串**（校验失败实测）也可能是**对象**（鉴权失败实测，
 * 形如 { error_type, message }），两种都要兼容；连 JSON 都不是时按原文处理。
 */
export function normalizeHttpError(status, bodyText) {
  const raw = String(bodyText == null ? "" : bodyText);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null; // 响应体不是 JSON：下面按原文处理
  }
  const detail = parsed && typeof parsed === "object" ? parsed.detail : undefined;
  let message = "";
  if (typeof detail === "string") {
    message = detail;
  } else if (detail && typeof detail === "object") {
    const inner = typeof detail.message === "string" ? detail.message : JSON.stringify(detail);
    message = typeof detail.error_type === "string" ? detail.error_type + ": " + inner : inner;
  } else if (parsed !== null && typeof parsed === "object") {
    message = JSON.stringify(parsed);
  } else if (parsed !== null) {
    message = String(parsed);
  } else {
    message = raw.trim();
  }
  if (!message) message = "（响应体为空）";
  const kind = statusKind(status);
  return {
    kind,
    status: Number(status),
    error: "Jev API HTTP " + status + (KIND_HINT[kind] || "") + "：" + truncateText(message, 600),
  };
}

/**
 * 构造单个 question 对象。纯函数。
 *
 * criteria 形状随 type 变（规约第 3 节）：noul 可选 { true, false }；
 * choice 必填 { 选项: 说明 }；score 必填 从低到高的等级数组（2–10 级）。
 * criteria 为 undefined/null 时不写该字段——noul 允许不写，choice/score 由
 * validateQuestion 在本地拦下，不必等一次必然失败的 400。
 */
export function buildQuestion(type, instructions, criteria) {
  const q = { type: String(type), instructions };
  if (criteria !== undefined && criteria !== null) q.criteria = criteria;
  return q;
}

/**
 * 本地校验 question 的三要素，避免拿必然 400 的请求去打网络。纯函数。
 *
 * @returns 通过返回 null，否则返回一句给人看的中文错误。
 */
export function validateQuestion(type, criteria) {
  if (!QUESTION_TYPES.includes(String(type))) {
    return 'question_type 必须是 ' + QUESTION_TYPES.join(" / ") + '，收到 "' + String(type) + '"。';
  }
  if (type === "noul") return null; // noul 的 criteria 可选
  if (criteria === undefined || criteria === null) {
    return type === "choice"
      ? "choice 的 criteria 必填：{ 选项: 该选项的说明 }，建议补一个 other/none of the above 兜底。"
      : "score 的 criteria 必填：从低到高的等级描述数组，至少 2 级、最多 10 级。";
  }
  if (type === "choice" && (typeof criteria !== "object" || Array.isArray(criteria))) {
    return "choice 的 criteria 必须是对象 { 选项: 说明 }。";
  }
  if (type === "score") {
    if (!Array.isArray(criteria)) return "score 的 criteria 必须是数组（从低到高的等级描述）。";
    if (criteria.length < 2) return "score 的 criteria 至少 2 级，收到 " + criteria.length + " 级。";
    if (criteria.length > 10) return "score 的 criteria 最多 10 级（API 上限），收到 " + criteria.length + " 级。";
  }
  return null;
}

/**
 * 把一个 answer 压成紧凑对象。纯函数。
 *
 * 必须带上的四件：value、confidence、judge_model、usage。
 * **noul 没有 confidence 字段**（官方语义：只有两个结果，单值即完整描述），
 * 这时给 null 并附 note 说明，不伪造一个数字。
 */
export function compactAnswer(id, answer, data) {
  const ans = answer && typeof answer === "object" ? answer : {};
  const type = ans.type;
  let value;
  if (type === "choice") value = ans.choice;
  else if (type === "score") value = ans.score;
  else if (type === "noul") value = ans.noul;
  else value = answer;

  const out = {
    id,
    type,
    value,
    confidence: typeof ans.confidence === "number" ? ans.confidence : null,
    judge_model: data && data.model ? data.model : null,
    usage: (data && data.usage) || null,
  };
  if (type === "noul") {
    out.note = "noul 只有 yes 概率一个数，官方不设 confidence 字段（单值即完整描述）；" +
      "它是「命题为真的概率」，不是被问事物的程度——度量程度请改用 score。";
  }
  if (ans.probabilities !== undefined) out.probabilities = ans.probabilities;
  if (ans.legend !== undefined) out.legend = ans.legend;
  return out;
}

/** 一次失败结果的紧凑 JSON 字符串。工具失败时返回它，而不是抛异常（与 BYK 其他工具一致：错误也是数据）。 */
export function errorJson(kind, message, extra) {
  const out = { ok: false, error_kind: kind, error: String(message) };
  if (extra && typeof extra === "object") Object.assign(out, extra);
  return JSON.stringify(out);
}

/**
 * 把一次判定结果压成工具返回的**紧凑 JSON 字符串**。
 *
 * @param result createJevCaller().call() 的返回值
 * @param id     这次判定用的 question id（单条判定固定 "q"）
 */
export function toJudgeJson(result, id) {
  const qid = id || "q";
  if (!result || result.ok !== true) {
    return errorJson((result && result.kind) || "http", (result && result.error) || "未知失败");
  }
  const answers = (result.data && result.data.answers) || {};
  const ans = answers[qid];
  if (!ans) {
    return errorJson("parse", "Jev 响应里没有 answers." + qid + "：" + truncateText(JSON.stringify(result.data), 400));
  }
  const out = { ok: true };
  Object.assign(out, compactAnswer(qid, ans, result.data));
  return JSON.stringify(out);
}

/** 把一次多题判定的结果压成紧凑 JSON 字符串（keys 与请求 questions 一一对应）。 */
export function toBatchJson(result) {
  if (!result || result.ok !== true) {
    return errorJson((result && result.kind) || "http", (result && result.error) || "未知失败");
  }
  const data = result.data || {};
  const answers = {};
  for (const [id, ans] of Object.entries(data.answers || {})) {
    answers[id] = compactAnswer(id, ans, data);
  }
  return JSON.stringify({
    ok: true,
    judge_model: data.model || null,
    usage: data.usage || null,
    answers,
  });
}

/**
 * 造一个 Jev 调用器。
 *
 * @param config config.jev 段：{ baseUrl, model, timeoutMs, apiKey, keyPath }
 * @param deps   注入点：{ fetch, env, existsSync, readFileSync, pluginDir, logger }
 *               —— fetch 可换成测试桩；env 默认真实 process.env。
 * @returns { call(state, questions, exec), describe() }
 *          call() **不抛异常**，一律返回 { ok:true, data, model, usage, keySource }
 *          或 { ok:false, kind, error, status? }。
 */
export function createJevCaller(config, deps) {
  const d = deps || {};
  const cfg = config || {};
  const baseUrl = String(cfg.baseUrl || DEFAULT_BASE_URL);
  const model = String(cfg.model || DEFAULT_MODEL);
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = d.fetch || (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);

  async function call(state, questions, exec) {
    if (typeof fetchImpl !== "function") {
      return { ok: false, kind: "config", error: "当前运行环境没有可用的 fetch（需要 Node 18+），无法调用 Jev。" };
    }
    let key = "";
    let source = "";
    try {
      const found = resolveApiKey(cfg, d);
      key = found.key;
      source = found.source;
    } catch (err) {
      return { ok: false, kind: (err && err.kind) || "config", error: String((err && err.message) || err) };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = exec && exec.signal;
    let signal = controller.signal;
    if (external) {
      // 同时响应宿主取消与自己这边的超时；AbortSignal.any 在 Node 20+ 可用。
      signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
        ? AbortSignal.any([external, controller.signal])
        : controller.signal;
    }

    try {
      const res = await fetchImpl(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({ state, model, questions }),
        signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, ...normalizeHttpError(res.status, text) };
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        return {
          ok: false,
          kind: "parse",
          error: "Jev 返回的不是合法 JSON（HTTP " + res.status + "）：" + truncateText(text, 400),
        };
      }
      return { ok: true, data, model: data.model, usage: data.usage, keySource: source };
    } catch (err) {
      const errName = err && err.name;
      if (errName === "AbortError" || errName === "TimeoutError") {
        if (timedOut) {
          return {
            ok: false,
            kind: "timeout",
            error: "Jev 调用超时（" + timeoutMs + " ms 内没有响应），已中止。" +
              "可用 config.jev.timeoutMs 调大，或缩小 state/questions。",
          };
        }
        return { ok: false, kind: "aborted", error: "Jev 调用被调用方取消（exec.signal 已 abort）。" };
      }
      const chain = errorChainText(err);
      return { ok: false, kind: "network", error: "Jev 请求失败：" + chain + networkHint(chain) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 给人看的自述：端点、模型、超时、key 从哪来（没配好就写 null，不抛）。 */
  function describe() {
    let source = null;
    try {
      source = resolveApiKey(cfg, d).source;
    } catch {
      source = null; // 没配 key 不是 describe() 的错，交给 call() 报
    }
    return { baseUrl, model, timeoutMs, keySource: source };
  }

  return { call, describe, baseUrl, model, timeoutMs };
}
