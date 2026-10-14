/**
 * byk_mood 的语义层：一次 Jev 调用固定问三件事——情绪基调（choice）、着急程度（score）、
 * 这一轮最需要先满足什么（choice）——并把结果压成工具返回的紧凑 JSON。
 *
 * 为什么单独一个模块、而不是塞进 lib/jev.js：
 *   lib/jev.js 是**传输层**（key 解析、HTTP、超时、错误归一化、返回压缩），
 *   本模块是**语义层**（问什么、选项是什么、结果怎么组装）。两者改动理由不同。
 *   HTTP / key 逻辑一律复用 jev.js（createJevCaller / buildQuestion / validateQuestion /
 *   compactAnswer / errorJson / truncateText），这里一行都不重写。
 *
 * 设计约束（用户 2026-10-06 的硬要求）：规则必须**通用、可迁移**。
 * 所以默认选项只按「情绪 / 紧迫度 / 诉求」这三个任何话题都成立的维度写，
 * 不出现任何绑定具体事务（例如某类具体事情）的选项；调用方要贴合自己的场景，
 * 用 criteria 覆盖，而不是让本模块替它写死。
 */
import {
  buildQuestion,
  compactAnswer,
  errorJson,
  truncateText,
  validateQuestion,
} from "./jev.js";

/** 三问的固定 question id。调用方不需要也不能改——改了响应键就对不上。 */
export const MOOD_IDS = ["q_emotion", "q_urgency", "q_need"];

/** criteria 允许覆盖的三个键，与 MOOD_IDS 一一对应。 */
export const MOOD_OVERRIDE_KEYS = ["emotion", "urgency", "need"];

/** q_emotion 的默认选项：情绪基调。只描述**语气**，不含任何具体事务。 */
export const DEFAULT_EMOTION_CRITERIA = {
  "中性": "语气平稳，像在陈述事实或提一个普通问题，读不出明显情绪",
  "紧迫着急": "在赶时间：催、强调期限、说「马上」「立刻」，希望尽快有结果",
  "焦虑压力": "担心出错或来不及：反复确认、语气紧绷、先假设会失败",
  "受挫不满": "对现状或结果失望：抱怨、反问、说「又」「还是不行」",
  "兴奋期待": "对要做的事有兴趣、语气积极、主动展开细节",
  "其他": "上面都不贴切，或者情绪很淡、读不出来",
};

/** q_urgency 的默认分级（score，从低到高 5 级）。等级数写死在这里，改级别就改这个数组。 */
export const DEFAULT_URGENCY_LEVELS = [
  "不着急：可以慢慢来，晚点给也没关系",
  "偏低：希望尽快，但排在别的事后面也行",
  "中等：按正常节奏推进，尽早给出结果就好",
  "偏高：有明确的时间压力，应当优先处理",
  "极急：立刻停下手上的事，先处理这个",
];

/** q_need 的默认选项：这一轮最需要先被满足什么。同样是通用维度。 */
export const DEFAULT_NEED_CRITERIA = {
  "被理解先确认": "想先被听到：先确认他的处境与感受，再谈怎么解决",
  "要立刻结果": "不想听过程：先给一个能马上用的结果或止血办法",
  "要方案与解释": "想看方案、取舍与理由，愿意读解释，再决定怎么做",
  "要被安抚": "情绪需要先落地：先稳住情绪，比马上给方案更要紧",
  "其他": "上面都不贴切",
};

/**
 * 三问的固定问法。state 就是"用户这一轮的输入"——所以每个 instructions 都先点明这一点，
 * 让 Jev 知道自己在读什么，而不是把 state 当百科条目。
 */
export const MOOD_INSTRUCTIONS = {
  q_emotion: "state 是用户这一轮的原话或输入。他说话时的情绪基调是哪一种？" +
    "只读文本本身表达出来的情绪，不要推测没写出来的事，也不要用「这件事通常多严重」反推情绪。",
  q_urgency: "state 是用户这一轮的原话或输入。他对「这件事多久要有结果」有多着急？" +
    "看语气、时间词与催促程度判断，不要按这件事本身通常有多重要来猜。",
  q_need: "state 是用户这一轮的原话或输入。他这一轮最需要先被满足的是什么？" +
    "同时像几种时，选最该先满足的那一个。",
};

/** 某一问最终用哪份 criteria：覆盖给了就用覆盖的（含显式 null，交给 validate 报错），否则用默认。 */
function criteriaFor(key, overrides) {
  if (overrides && overrides[key] !== undefined) return overrides[key];
  if (key === "emotion") return DEFAULT_EMOTION_CRITERIA;
  if (key === "urgency") return DEFAULT_URGENCY_LEVELS;
  return DEFAULT_NEED_CRITERIA;
}

/** 三问各自的问题类型：情绪=choice、着急=score、诉求=choice。 */
const MOOD_TYPES = { emotion: "choice", urgency: "score", need: "choice" };

/**
 * 造这次调用的 questions 对象（三个键 = MOOD_IDS，顺序固定）。
 *
 * @param overrides 可选的 criteria 覆盖 { emotion?, urgency?, need? }；缺哪个用哪个的默认值
 * @returns { q_emotion, q_urgency, q_need } 可直接交给 jev.call()
 */
export function moodQuestions(overrides) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  return {
    q_emotion: buildQuestion(MOOD_TYPES.emotion, MOOD_INSTRUCTIONS.q_emotion, criteriaFor("emotion", o)),
    q_urgency: buildQuestion(MOOD_TYPES.urgency, MOOD_INSTRUCTIONS.q_urgency, criteriaFor("urgency", o)),
    q_need: buildQuestion(MOOD_TYPES.need, MOOD_INSTRUCTIONS.q_need, criteriaFor("need", o)),
  };
}

/**
 * 本地校验 criteria 覆盖，避免拿必然 400 的请求去打网络（复用 jev.js 的 validateQuestion）。
 *
 * @returns 通过返回 null，否则返回一句给人看的中文错误（调用方以 error_kind=config 返回）
 */
export function validateMoodCriteria(overrides) {
  const o = overrides;
  if (o !== undefined && o !== null) {
    if (typeof o !== "object" || Array.isArray(o)) {
      return "criteria 必须是对象 { emotion?, urgency?, need? }，每个键覆盖对应那一问的选项。";
    }
    const extra = Object.keys(o).filter((k) => !MOOD_OVERRIDE_KEYS.includes(k));
    if (extra.length > 0) {
      return "criteria 只认 " + MOOD_OVERRIDE_KEYS.join(" / ") + " 三个键，收到多余键：" +
        extra.join("、") + "。多出来的问题请用 byk_judge_batch 单独问。";
    }
  }
  for (const key of MOOD_OVERRIDE_KEYS) {
    const bad = validateQuestion(MOOD_TYPES[key], criteriaFor(key, o));
    if (bad) return "criteria." + key + "：" + bad;
  }
  return null;
}

/**
 * 把一次 byk_mood 调用的结果压成工具返回的**紧凑 JSON 字符串**。失败也返回 JSON，不抛异常。
 *
 * 成功形状：{ ok:true, emotion:{...}, urgency:{...}, need:{...}, judge_model, usage }
 *   - 每条带 id / type / value / confidence；choice 另带 probabilities，score 另带 legend 与 probabilities。
 *   - judge_model 与 usage 是整次请求的一份，放顶层，不逐条重复。
 *   - **不伪造 confidence**：这里三问都是 choice/score，官方一定给 confidence；
 *     万一某个 answer 没带，就是 null（如实为空，不编数）。
 * 失败形状：{ ok:false, error_kind, error }
 *
 * @param result createJevCaller().call() 的返回值
 */
export function toMoodJson(result) {
  if (!result || result.ok !== true) {
    return errorJson((result && result.kind) || "http", (result && result.error) || "未知失败");
  }
  const data = result.data || {};
  const answers = data.answers || {};
  const out = { ok: true };
  for (const id of MOOD_IDS) {
    const ans = answers[id];
    if (!ans) {
      return errorJson(
        "parse",
        "Jev 响应里没有 answers." + id + "：" + truncateText(JSON.stringify(data), 400),
      );
    }
    const compact = compactAnswer(id, ans, data);
    delete compact.judge_model; // 整次请求一份，已经放在顶层
    delete compact.usage;
    out[id.slice(2)] = compact; // q_emotion -> emotion
  }
  out.judge_model = data.model || null;
  out.usage = data.usage || null;
  return JSON.stringify(out);
}

/** 给人看的一行摘要（进度播报用）：只读不写，失败时也不抛。 */
export function summarizeMood(jsonText) {
  let v;
  try {
    v = JSON.parse(String(jsonText));
  } catch {
    return "情绪判读结果不是合法 JSON（" + truncateText(String(jsonText), 120) + "）";
  }
  if (!v.ok) return "情绪判读失败：[" + String(v.error_kind) + "] " + String(v.error);
  const parts = MOOD_IDS.map((id) => {
    const a = v[id.slice(2)] || {};
    const conf = typeof a.confidence === "number" ? "（confidence " + a.confidence + "）" : "";
    return String(a.value) + conf;
  });
  return "情绪：" + parts[0] + " ｜ 着急：" + parts[1] + " ｜ 最需要：" + parts[2];
}
