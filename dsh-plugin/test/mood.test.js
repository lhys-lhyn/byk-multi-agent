/**
 * byk_mood 单测：默认三问的形状、criteria 覆盖与本地校验、结果压缩、
 * 失败分支（缺 key → config / 伪造 key 与 HTTP 401 → auth / 缺 answer → parse），
 * 以及**真打 Jev** 的调用（同一次请求里就覆盖 choice 与 score 两类）。
 *
 * 运行：node test/mood.test.js
 *   - 桩用例永远跑；
 *   - 真调用需要能解析到 key（config.jev.apiKey / TYPESAFE_API_KEY / JEV_API_KEY /
 *     <DSH_HOME>/jev.key …）。解析不到就打一行 SKIP 并跳过，**不伪装成通过**。
 */
import assert from "node:assert/strict";
import { createJevCaller, resolveApiKey } from "../lib/jev.js";
import {
  MOOD_IDS,
  DEFAULT_EMOTION_CRITERIA,
  DEFAULT_NEED_CRITERIA,
  DEFAULT_URGENCY_LEVELS,
  moodQuestions,
  validateMoodCriteria,
  toMoodJson,
  summarizeMood,
} from "../lib/mood.js";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log("  ✓ " + label);
}

/** 桩 fetch：固定响应体 + 记下每次请求（url / body / headers）。与 test/jev.test.js 同款。 */
function stubFetch(payload, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: opts && opts.body, headers: opts && opts.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  fn.calls = calls;
  return fn;
}

const BASE_CONFIG = { apiKey: "sk_test_key", baseUrl: "https://example.invalid/v1/systemone", timeoutMs: 2000 };

/** 一次"成功"的 byk_mood 响应：choice + score + choice，形状照 docs/jev-planning-spec.md 第 3 节。 */
const GOOD_MOOD = {
  model: "jev-1.13.0",
  answers: {
    q_emotion: {
      type: "choice", choice: "紧迫着急", confidence: 0.92,
      probabilities: { "中性": 0.01, "紧迫着急": 0.92, "焦虑压力": 0.05, "受挫不满": 0.02, "兴奋期待": 0, "其他": 0 },
    },
    q_urgency: {
      type: "score", score: 3.9, confidence: 0.9,
      legend: { "0": DEFAULT_URGENCY_LEVELS[0], "4": DEFAULT_URGENCY_LEVELS[4] },
      probabilities: { "3": 0.9, "4": 0.1 },
    },
    q_need: {
      type: "choice", choice: "要立刻结果", confidence: 0.85,
      probabilities: { "要立刻结果": 0.85, "其他": 0.15 },
    },
  },
  usage: { input_tokens: 620, output_tokens: 96 },
};

// ── 1. 默认三问：id、类型、criteria 三要素齐全 ─────────────────────────
{
  const qs = moodQuestions();
  assert.deepEqual(Object.keys(qs), MOOD_IDS, "三问的键必须固定且按顺序");
  assert.equal(qs.q_emotion.type, "choice");
  assert.equal(qs.q_urgency.type, "score");
  assert.equal(qs.q_need.type, "choice");
  assert.deepEqual(qs.q_emotion.criteria, DEFAULT_EMOTION_CRITERIA);
  assert.deepEqual(qs.q_urgency.criteria, DEFAULT_URGENCY_LEVELS);
  assert.deepEqual(qs.q_need.criteria, DEFAULT_NEED_CRITERIA);
  // choice 必须给兜底选项（validateQuestion 的规约建议），否则读不出情绪时会硬选一个
  for (const c of [DEFAULT_EMOTION_CRITERIA, DEFAULT_NEED_CRITERIA]) assert.ok(c["其他"], "choice 要有兜底项");
  assert.ok(DEFAULT_URGENCY_LEVELS.length >= 2 && DEFAULT_URGENCY_LEVELS.length <= 10);
  for (const id of MOOD_IDS) assert.ok(qs[id].instructions.length > 10, id + " 要有 instructions");
  ok("默认三问：choice/score/choice 各带 criteria 与 instructions，choice 有兜底项");
}

// ── 2. criteria 覆盖：给的用给的，没给的仍用默认 ───────────────────────
{
  const emotion = { 平静: "没事，随便问问", 烦躁: "明显不耐烦", other: "读不出来" };
  const urgency = ["随便什么时候都行", "今天必须"];
  const need = { 只要答案: "别解释过程" };
  const qs = moodQuestions({ emotion, urgency, need });
  assert.deepEqual(qs.q_emotion.criteria, emotion);
  assert.deepEqual(qs.q_urgency.criteria, urgency);
  assert.deepEqual(qs.q_need.criteria, need);
  const partial = moodQuestions({ urgency });
  assert.deepEqual(partial.q_urgency.criteria, urgency);
  assert.deepEqual(partial.q_emotion.criteria, DEFAULT_EMOTION_CRITERIA, "只覆盖一项时其余保持默认");
  // null/undefined 与"没给"同义：都不算覆盖
  assert.deepEqual(moodQuestions(null).q_urgency.criteria, DEFAULT_URGENCY_LEVELS);
  ok("criteria 覆盖：逐项生效，未覆盖项保持通用默认");
}

// ── 3. 本地校验：形状不对就拦下，不拿必然 400 的请求去打网络 ───────────
{
  assert.equal(validateMoodCriteria(undefined), null);
  assert.equal(validateMoodCriteria({}), null);
  assert.match(validateMoodCriteria(["a"]), /必须是对象/);
  assert.match(validateMoodCriteria({ mood: {} }), /多余键/);
  assert.match(validateMoodCriteria({ emotion: ["a"] }), /criteria\.emotion/);
  assert.match(validateMoodCriteria({ urgency: ["只有一级"] }), /criteria\.urgency.*至少 2 级/s);
  assert.match(validateMoodCriteria({ urgency: { "0": "低" } }), /criteria\.urgency.*必须是数组/s);
  assert.match(validateMoodCriteria({ need: null }), /criteria\.need.*必填/s);
  ok("validateMoodCriteria：对象形状、多余键、choice/score 的 criteria 形状全部拦下并点名是哪一问");
}

// ── 4. 成功路径（桩）：请求体三键齐全，返回 emotion/urgency/need + judge_model + usage
{
  const f = stubFetch(GOOD_MOOD);
  const jev = createJevCaller({ ...BASE_CONFIG }, { fetch: f, env: {} });
  const STATE = "这条链路我已经重试三遍了，今天必须交出去。";
  const r = await jev.call(STATE, moodQuestions(), null);
  assert.equal(r.ok, true, r.error);

  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.state, STATE, "state 原样透传，不做改写");
  assert.deepEqual(Object.keys(body.questions), MOOD_IDS);
  assert.equal(body.questions.q_urgency.type, "score");
  assert.equal(f.calls[0].headers.Authorization, "Bearer sk_test_key");

  const j = toMoodJson(r);
  assert.equal(typeof j, "string");
  const v = JSON.parse(j);
  assert.equal(v.ok, true);
  assert.equal(v.emotion.value, "紧迫着急");
  assert.equal(v.emotion.type, "choice");
  assert.equal(v.emotion.confidence, 0.92);
  assert.equal(v.emotion.id, "q_emotion");
  assert.deepEqual(v.emotion.probabilities, GOOD_MOOD.answers.q_emotion.probabilities);
  assert.equal(v.urgency.value, 3.9);
  assert.equal(v.urgency.type, "score");
  assert.equal(v.urgency.confidence, 0.9);
  assert.ok(v.urgency.legend, "score 必须带 legend（否则等级号读不出来）");
  assert.equal(v.urgency.legend["4"], DEFAULT_URGENCY_LEVELS[4]);
  assert.equal(v.need.value, "要立刻结果");
  assert.equal(v.judge_model, "jev-1.13.0");
  assert.deepEqual(v.usage, { input_tokens: 620, output_tokens: 96 });
  // judge_model / usage 是整次请求的一份，不逐条重复
  for (const k of ["emotion", "urgency", "need"]) {
    assert.ok(!("judge_model" in v[k]), k + " 不该再抄一份 judge_model");
    assert.ok(!("usage" in v[k]), k + " 不该再抄一份 usage");
    assert.ok("value" in v[k] && "confidence" in v[k], k + " 缺 value/confidence");
  }
  assert.equal(typeof summarizeMood(j), "string");
  assert.match(summarizeMood(j), /紧迫着急/);
  assert.match(summarizeMood(j), /3\.9/);
  ok("成功路径：三问各一条完整判定（choice 带 probabilities / score 带 legend），judge_model 与 usage 在顶层");
}

// ── 5. 缺 key → error_kind=config（错误文本点名找过的位置） ────────────
{
  const missing = {
    fetch: stubFetch(GOOD_MOOD),
    env: { DSH_HOME: "C:\\DSHHome", DSH_PROFILE: "desktop" },
    existsSync: () => false,
    readFileSync: () => "",
  };
  const jev = createJevCaller({ baseUrl: "https://example.invalid/x", timeoutMs: 1000 }, missing);
  const r = await jev.call("随便一句话", moodQuestions(), null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "config");
  const v = JSON.parse(toMoodJson(r));
  assert.equal(v.ok, false);
  assert.equal(v.error_kind, "config");
  for (const needle of ["config.jev.apiKey", "TYPESAFE_API_KEY", "JEV_API_KEY", "jev.key"]) {
    assert.ok(v.error.includes(needle), "错误文本应点名 " + needle + "，实际：" + v.error);
  }
  ok("缺 key：error_kind=config，且点名每一处找过的地方（no silent fallback）");
}

// ── 6. HTTP 401 → error_kind=auth（桩，detail 为对象：实测形态） ────────
{
  const body = {
    detail: {
      error_type: "authentication_error",
      message: "Cannot authenticate with the server. Please check your API key and try again.",
    },
  };
  const jev = createJevCaller({ ...BASE_CONFIG }, { fetch: stubFetch(body, 401), env: {} });
  const r = await jev.call("随便一句话", moodQuestions(), null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "auth");
  assert.equal(r.status, 401);
  const v = JSON.parse(toMoodJson(r));
  assert.equal(v.ok, false);
  assert.equal(v.error_kind, "auth");
  assert.ok(v.error.includes("authentication_error"), v.error);
  ok("HTTP 401：error_kind=auth，error_type/message 都带出来");
}

// ── 7. 响应缺某一问的 answer → error_kind=parse（不当成 ok） ───────────
{
  const partial = { model: "jev-1.13.0", answers: { q_emotion: { type: "choice", choice: "中性", confidence: 1 } }, usage: {} };
  const jev = createJevCaller({ ...BASE_CONFIG }, { fetch: stubFetch(partial), env: {} });
  const v = JSON.parse(toMoodJson(await jev.call("x", moodQuestions(), null)));
  assert.equal(v.ok, false);
  assert.equal(v.error_kind, "parse");
  assert.match(v.error, /q_urgency|q_need/);
  // 失败也要能出一行摘要，且如实说明失败，不假装"情绪平静"
  assert.match(summarizeMood(JSON.stringify(v)), /失败/);
  ok("缺 answer：error_kind=parse，失败不会被读成「情绪平静」");
}

// ── 8. 真打 Jev（需要 key；解析不到就打 SKIP 并跳过） ──────────────────
const STATE = "又报错了？这个流程我已经重试三遍了，今天必须交出去，你先告诉我到底能不能行。";
let keyInfo = null;
try {
  keyInfo = resolveApiKey({}, { env: process.env });
} catch {
  keyInfo = null; // 没 key 不是失败，是本机没配：下面打 SKIP
}

if (!keyInfo) {
  console.log("SKIP: Jev key 未配置（config.jev.apiKey / TYPESAFE_API_KEY / JEV_API_KEY / <DSH_HOME>/jev.key 都没取到），第 8 节真调用跳过");
} else {
  console.log("  真调用使用的 key 来源：" + keyInfo.source);
  const real = createJevCaller({ timeoutMs: 60000 }, { fetch: globalThis.fetch, env: process.env });

  // 8a) 默认三问：一次请求里同时覆盖 choice（q_emotion / q_need）与 score（q_urgency）
  const r1 = await real.call(STATE, moodQuestions(), null);
  const j1 = toMoodJson(r1);
  console.log("  真实调用 1（默认三问）原始返回：\n" + j1);
  const v1 = JSON.parse(j1);
  assert.equal(v1.ok, true, j1);
  assert.equal(v1.emotion.type, "choice");
  assert.equal(v1.urgency.type, "score");
  assert.equal(v1.need.type, "choice");
  assert.ok(Object.keys(DEFAULT_EMOTION_CRITERIA).includes(v1.emotion.value), "情绪取值必须落在默认选项里：" + v1.emotion.value);
  assert.ok(Object.keys(DEFAULT_NEED_CRITERIA).includes(v1.need.value), "诉求取值必须落在默认选项里：" + v1.need.value);
  assert.equal(typeof v1.emotion.confidence, "number", "choice 必须给 confidence");
  assert.equal(typeof v1.urgency.confidence, "number", "score 必须给 confidence");
  assert.equal(typeof v1.urgency.value, "number", "score 的 value 是概率加权等级位置");
  assert.ok(v1.urgency.legend && typeof v1.urgency.legend === "object", "score 要带 legend");
  assert.ok(v1.urgency.probabilities, "score 要带 probabilities（同一 score 可由不同分布产生）");
  assert.ok(v1.emotion.probabilities, "choice 要带 probabilities");
  assert.ok(v1.judge_model, "要回报服务端实际模型版本");
  assert.ok(v1.usage, "要回报 usage");
  ok("真调用 1：默认三问拿到 emotion(choice)/urgency(score)/need(choice) 完整判定 · " + summarizeMood(j1));

  // 8b) 自定义 criteria：证明覆盖真的会被用上（选项原文回显在 probabilities / legend 里）
  const OVERRIDE = {
    emotion: { 平静淡然: "就是随口问问，没有情绪", 明显烦躁: "很不耐烦、在抱怨", 读不出来: "信息太少，判不了" },
    urgency: ["不赶时间", "这周内", "今天必须"],
    need: { 别解释先给结果: "不想听过程", 说清原因: "想知道为什么", 拿不准: "读不出来" },
  };
  const r2 = await real.call(STATE, moodQuestions(OVERRIDE), null);
  const j2 = toMoodJson(r2);
  console.log("  真实调用 2（自定义 criteria 覆盖）原始返回：\n" + j2);
  const v2 = JSON.parse(j2);
  assert.equal(v2.ok, true, j2);
  assert.ok(Object.keys(OVERRIDE.emotion).includes(v2.emotion.value), "覆盖后的情绪选项没被用上：" + v2.emotion.value);
  assert.ok(Object.keys(OVERRIDE.need).includes(v2.need.value), "覆盖后的诉求选项没被用上：" + v2.need.value);
  assert.equal(v2.urgency.legend["0"], OVERRIDE.urgency[0], "覆盖后的等级描述必须原文回显");
  assert.equal(v2.urgency.legend["2"], OVERRIDE.urgency[2], "覆盖后的等级描述必须原文回显");
  ok("真调用 2：criteria 覆盖生效（选项与等级描述被服务端原文回显）· " + summarizeMood(j2));

  // 8c) 伪造 key → auth（真打；鉴权在推理之前失败，不产生模型用量）
  const forged = createJevCaller({ apiKey: "sk-forged-by-mood-test-0000", timeoutMs: 30000 }, { fetch: globalThis.fetch, env: process.env });
  const j3 = toMoodJson(await forged.call(STATE, moodQuestions(), null));
  console.log("  真实调用 3（伪造 key）原始返回：\n" + j3);
  const v3 = JSON.parse(j3);
  assert.equal(v3.ok, false, j3);
  assert.equal(v3.error_kind, "auth", j3);
  ok("真调用 3：伪造 key → error_kind=auth");
}

console.log("\ntest/mood.test.js：" + passed + " 组断言全部通过。");
