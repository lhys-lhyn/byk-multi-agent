/**
 * Jev 调用层单测：解析、错误归一化、超时、缺 key 报错、返回 JSON 形状。
 * 不联网、不依赖 DSH 运行时 —— fetch 全部用桩。
 * 运行：node test/jev.test.js
 */
import assert from "node:assert/strict";
import {
  createJevCaller,
  resolveApiKey,
  keyFileCandidates,
  buildQuestion,
  validateQuestion,
  normalizeHttpError,
  compactAnswer,
  toJudgeJson,
  toBatchJson,
  errorJson,
  truncateText,
  errorChainText,
  networkHint,
  QUESTION_TYPES,
} from "../lib/jev.js";

let passed = 0;
function ok(label) {
  passed += 1;
  console.log("  ✓ " + label);
}

/** 桩 fetch：固定响应体 + 记下每次请求（url / body / headers）。 */
function stubFetch(payload, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: opts && opts.body, headers: opts && opts.headers, hasSignal: Boolean(opts && opts.signal) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  fn.calls = calls;
  return fn;
}

/** 永远不 resolve 的桩 fetch，但遵守 AbortSignal —— 用来跑超时路径。 */
function hangingFetch() {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url });
    return new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      const onAbort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (!signal) return;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  fn.calls = calls;
  return fn;
}

const GOOD = {
  model: "jev-1.13.0",
  answers: { q: { type: "noul", noul: 0.07 } },
  usage: { input_tokens: 556, output_tokens: 78 },
};

const BASE_CONFIG = {
  apiKey: "sk_test_key",
  baseUrl: "https://example.invalid/v1/systemone",
  model: "jev-latest",
  timeoutMs: 2000,
};

function jevWith(fetchImpl, configOverride, depsOverride) {
  return createJevCaller(
    { ...BASE_CONFIG, ...(configOverride || {}) },
    { fetch: fetchImpl, env: {}, ...(depsOverride || {}) },
  );
}

const Q_NOUL = { q: buildQuestion("noul", "改动是否满足验收标准？", { true: "达标", false: "不达标" }) };

// ── 1. 类型表 ──────────────────────────────────────────────────────────
assert.deepEqual(QUESTION_TYPES, ["noul", "choice", "score"]);
ok("QUESTION_TYPES = noul / choice / score");

// ── 2. noul：正常解析 + 请求体形状 + noul 不给假 confidence ─────────────
{
  const f = stubFetch(GOOD);
  const r = await jevWith(f).call("CI-2187 导出失败", Q_NOUL, null);
  assert.equal(r.ok, true);

  const body = JSON.parse(f.calls[0].body);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state, "CI-2187 导出失败");
  assert.equal(body.questions.q.type, "noul");
  assert.equal(f.calls[0].headers.Authorization, "Bearer sk_test_key");
  assert.equal(f.calls[0].hasSignal, true);

  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.ok, true);
  assert.equal(j.value, 0.07);
  assert.equal(j.confidence, null, "noul 不能伪造 confidence");
  assert.equal(typeof j.note, "string");
  assert.ok(j.note.includes("noul"));
  assert.equal(j.judge_model, "jev-1.13.0");
  assert.deepEqual(j.usage, { input_tokens: 556, output_tokens: 78 });
  assert.equal(j.type, "noul");
  ok("noul：value/confidence(null)/judge_model/usage 齐全，请求体与鉴权头正确");
}

// ── 3. choice：value=选中项，带 confidence 与 probabilities ─────────────
{
  const payload = {
    model: "jev-1.13.0",
    answers: { q: { type: "choice", choice: "frontend", confidence: 1.0, probabilities: { docs: 0, backend: 0, frontend: 1, other: 0 } } },
    usage: { input_tokens: 556, output_tokens: 78 },
  };
  const r = await jevWith(stubFetch(payload)).call("ticket", {
    q: buildQuestion("choice", "这个工单该先给哪个团队？", { frontend: "前端渲染", backend: "服务端", other: "都不像" }),
  }, null);
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.value, "frontend");
  assert.equal(j.confidence, 1.0);
  assert.deepEqual(j.probabilities, { docs: 0, backend: 0, frontend: 1, other: 0 });
  assert.equal(j.judge_model, "jev-1.13.0");
  ok("choice：value = 概率最高的选项，confidence / probabilities 一并返回");
}

// ── 4. score：value 是概率加权等级，带 legend ───────────────────────────
{
  const payload = {
    model: "jev-1.13.0",
    answers: {
      q: {
        type: "score", score: 1.01, confidence: 0.99,
        legend: { 0: "观感问题", 1: "功能降级但有绕行", 2: "阻断且无绕行" },
        probabilities: { 0: 0.0, 1: 0.99, 2: 0.01 },
      },
    },
    usage: { input_tokens: 556, output_tokens: 78 },
  };
  const r = await jevWith(stubFetch(payload)).call("ticket", {
    q: buildQuestion("score", "这个问题对客户有多严重？", ["观感问题", "功能降级但有绕行", "阻断且无绕行"]),
  }, null);
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.value, 1.01);
  assert.equal(j.confidence, 0.99);
  assert.equal(j.legend["2"], "阻断且无绕行");
  assert.equal(j.usage.output_tokens, 78);
  ok("score：value / confidence / legend / probabilities 齐全");
}

// ── 5. HTTP 400：detail 是字符串（实测形态） ───────────────────────────
{
  const body = { detail: "Noul question must have criteria or instructions: q" };
  const r = await jevWith(stubFetch(body, 400)).call("hello", { q: { type: "noul" } }, null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "invalid");
  assert.equal(r.status, 400);
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.ok, false);
  assert.equal(j.error_kind, "invalid");
  assert.ok(j.error.includes("HTTP 400"), j.error);
  assert.ok(j.error.includes("Noul question must have criteria or instructions: q"), j.error);
  assert.ok(j.error.includes("criteria"), j.error);
  ok("HTTP 400（detail 为字符串）：归一化成 invalid，原文进 error 文本");
}

// ── 6. HTTP 401：detail 是对象（实测形态） ─────────────────────────────
{
  const body = {
    detail: {
      error_type: "authentication_error",
      message: "Cannot authenticate with the server. Please check your API key and try again.",
    },
  };
  const r = await jevWith(stubFetch(body, 401)).call("hello", { q: { type: "noul", instructions: "x" } }, null);
  assert.equal(r.kind, "auth");
  assert.equal(r.status, 401);
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.error_kind, "auth");
  assert.ok(j.error.includes("authentication_error"), j.error);
  assert.ok(j.error.includes("Cannot authenticate with the server"), j.error);
  ok("HTTP 401（detail 为对象）：归一化成 auth，error_type/message 都带出来");
}

// ── 7. 其他状态码归类 + 非 JSON 响应体 ─────────────────────────────────
{
  assert.equal(normalizeHttpError(429, "{}").kind, "rate_limit");
  assert.equal(normalizeHttpError(529, "{}").kind, "overloaded");
  assert.equal(normalizeHttpError(503, "{}").kind, "server");
  assert.equal(normalizeHttpError(418, "teapot").kind, "http");
  assert.ok(normalizeHttpError(503, "<html>bad gateway</html>").error.includes("bad gateway"));
  assert.ok(normalizeHttpError(500, "").error.includes("响应体为空"));
  ok("状态码归类 429/529/5xx/其他 + 非 JSON 响应体降级为原文");
}

// ── 8. 超时：AbortController 触发，错误里点明毫秒数 ─────────────────────
{
  const f = hangingFetch();
  const t0 = Date.now();
  const r = await jevWith(f, { timeoutMs: 60 }).call("x", Q_NOUL, null);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.kind, "timeout");
  assert.ok(r.error.includes("60"), r.error);
  assert.ok(elapsed < 1500, "应立刻中止，实际 " + elapsed + "ms");
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.error_kind, "timeout");
  ok("超时路径：kind=timeout，耗时 " + elapsed + "ms，错误文本含 timeoutMs");
}

// ── 9. 调用方 exec.signal 取消 → aborted（与本地超时区分开） ───────────
{
  const f = hangingFetch();
  const ac = new AbortController();
  const p = jevWith(f).call("x", Q_NOUL, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.kind, "aborted");
  ok("外部 exec.signal 取消：kind=aborted，不误报成 timeout");
}

// ── 10. 缺 key：报错文本点名找过哪些位置，不静默失败 ───────────────────
{
  // 真实环境里插件跑在宿主进程内，DSH_HOME / DSH_PROFILE 是有的 —— 桩也用它们，
  // 好验证「候选位置来自环境」的那两条（profiles/jev.key 与 profiles/<profile>/jev.key）。
  const HOST_ENV = { DSH_HOME: "C:\\DSHHome", DSH_PROFILE: "desktop" };
  const missing = { fetch: stubFetch(GOOD), env: HOST_ENV, existsSync: () => false, readFileSync: () => "" };
  const jev = createJevCaller({ baseUrl: "https://example.invalid/x", model: "jev-latest", timeoutMs: 1000 }, missing);

  assert.throws(
    () => resolveApiKey({}, missing),
    (err) => err && err.kind === "config" && /API key 未配置/.test(err.message),
  );

  const r = await jev.call("x", Q_NOUL, null);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "config");
  const j = JSON.parse(toJudgeJson(r, "q"));
  assert.equal(j.ok, false);
  assert.equal(j.error_kind, "config");

  for (const needle of ["config.jev.apiKey", "TYPESAFE_API_KEY", "JEV_API_KEY", "profiles", "key.txt", "jev.key"]) {
    assert.ok(j.error.includes(needle), "错误文本应点名 " + needle + "，实际：" + j.error);
  }
  // 每一个候选文件位置都要出现在错误文本里
  const candidates = keyFileCandidates({}, { env: HOST_ENV });
  assert.ok(candidates.length >= 4, "候选位置太少：" + candidates.length);
  for (const p of candidates) {
    assert.ok(j.error.includes(p), "错误文本应含候选路径 " + p);
  }
  // 宿主 dsh-plugin-jev 在本机实际生效的那个位置也要在候选里
  assert.ok(candidates.some((p) => p.endsWith("profiles\\desktop\\jev.key")), "缺宿主布局候选：" + candidates.join(" | "));
  assert.equal(jev.describe().keySource, null);
  assert.equal(jev.describe().timeoutMs, 1000);
  ok("缺 key：抛 JevError(kind=config)，错误文本逐条点名 " + candidates.length + " 个文件候选 + 2 个环境变量 + 1 个配置项");
}

// ── 11. key 解析优先级与文件回退 ───────────────────────────────────────
{
  const env = { TYPESAFE_API_KEY: "sk_env_ts", JEV_API_KEY: "sk_env_jev" };
  assert.equal(resolveApiKey({ apiKey: "sk_cfg" }, { env }).key, "sk_cfg");
  assert.equal(resolveApiKey({}, { env }).source, "环境变量 TYPESAFE_API_KEY");
  assert.equal(resolveApiKey({}, { env: { JEV_API_KEY: "sk_env_jev" } }).key, "sk_env_jev");

  // keyPath 显式指定：优先于默认文件位置
  const deps = {
    env: {},
    existsSync: (p) => p === "D:\\somewhere\\my.key" || p.endsWith("key.txt"),
    readFileSync: (p) => (p === "D:\\somewhere\\my.key" ? "  sk_from_keypath \n" : "sk_from_keytxt\n"),
  };
  assert.equal(resolveApiKey({ keyPath: "D:\\somewhere\\my.key" }, deps).key, "sk_from_keypath");
  assert.equal(resolveApiKey({}, deps).source, "文件 " + keyFileCandidates({}, deps).find((p) => p.endsWith("key.txt")));

  // 有 key 才能发请求：从文件读到的 key 要真的进 Authorization 头
  const f = stubFetch(GOOD);
  const r = await createJevCaller(
    { baseUrl: "https://example.invalid/x", timeoutMs: 1000, keyPath: "D:\\somewhere\\my.key" },
    { ...deps, fetch: f },
  ).call("x", Q_NOUL, null);
  assert.equal(r.ok, true);
  assert.equal(r.keySource, "文件 D:\\somewhere\\my.key");
  assert.equal(f.calls[0].headers.Authorization, "Bearer sk_from_keypath");
  ok("key 优先级：apiKey > TYPESAFE_API_KEY > JEV_API_KEY > keyPath > 默认文件位置");
}

// ── 12. criteria 形状的本地校验（不拿必然 400 的请求去打网络） ─────────
{
  assert.equal(validateQuestion("noul", undefined), null);
  assert.equal(validateQuestion("choice", { a: "A", other: "都不像" }), null);
  assert.equal(validateQuestion("score", ["低", "高"]), null);
  assert.ok(/question_type/.test(validateQuestion("noul2", {})));
  assert.ok(/choice 的 criteria 必填/.test(validateQuestion("choice", null)));
  assert.ok(/score 的 criteria 必填/.test(validateQuestion("score", undefined)));
  assert.ok(/必须是对象/.test(validateQuestion("choice", ["a"])));
  assert.ok(/必须是数组/.test(validateQuestion("score", { 0: "低" })));
  assert.ok(/至少 2 级/.test(validateQuestion("score", ["只有一级"])));
  assert.ok(/最多 10 级/.test(validateQuestion("score", ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])));
  // noul 不写 criteria 时，buildQuestion 不带该字段
  assert.deepEqual(Object.keys(buildQuestion("noul", "Q?")), ["type", "instructions"]);
  ok("validateQuestion：三类型的 criteria 形状校验 + buildQuestion 不塞空 criteria");
}

// ── 13. 多题一次调用：answers 键与 questions 键一一对应 ────────────────
{
  const payload = {
    model: "jev-1.13.0",
    answers: {
      acceptance_pass: { type: "noul", noul: 0.07 },
      route: { type: "choice", choice: "frontend", confidence: 1.0, probabilities: { frontend: 1, other: 0 } },
      risk: { type: "score", score: 1.01, confidence: 0.99, legend: { 0: "轻", 1: "中" }, probabilities: { 0: 0, 1: 1 } },
    },
    usage: { input_tokens: 556, output_tokens: 78 },
  };
  const questions = {
    acceptance_pass: buildQuestion("noul", "是否满足验收标准？", { true: "达标", false: "不达标" }),
    route: buildQuestion("choice", "先给哪个团队？", { frontend: "前端", other: "都不像" }),
    risk: buildQuestion("score", "多严重？", ["轻", "中"]),
  };
  const f = stubFetch(payload);
  const r = await jevWith(f).call("ticket", questions, null);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].body).questions).sort(), ["acceptance_pass", "risk", "route"]);

  const j = JSON.parse(toBatchJson(r));
  assert.equal(j.ok, true);
  assert.equal(j.judge_model, "jev-1.13.0");
  assert.deepEqual(j.usage, { input_tokens: 556, output_tokens: 78 });
  assert.deepEqual(Object.keys(j.answers).sort(), ["acceptance_pass", "risk", "route"]);
  assert.equal(j.answers.acceptance_pass.value, 0.07);
  assert.equal(j.answers.acceptance_pass.confidence, null);
  assert.equal(j.answers.route.value, "frontend");
  assert.equal(j.answers.risk.value, 1.01);
  ok("多题一次调用：3 个键各返回一条完整判定，usage 是整次请求的一份");
}

// ── 14. 返回值一定是合法 JSON 字符串，且四件套齐全 ─────────────────────
{
  const shapes = [
    toJudgeJson({ ok: true, data: GOOD }, "q"),
    toJudgeJson({ ok: false, kind: "timeout", error: "超时" }, "q"),
    toBatchJson({ ok: true, data: GOOD }),
    toBatchJson({ ok: false, kind: "config", error: "缺 key" }),
    errorJson("config", "x"),
  ];
  for (const s of shapes) {
    assert.equal(typeof s, "string");
    const v = JSON.parse(s); // 不合法会直接抛
    assert.equal(typeof v.ok, "boolean");
    if (v.ok === true && v.answers && typeof v.answers === "object") {
      // 批量：顶层是 judge_model / usage / answers，四件套在每条 answer 里
      assert.ok("judge_model" in v && "usage" in v, "批量结果缺 judge_model/usage：" + s);
      for (const [id, a] of Object.entries(v.answers)) {
        assert.ok("value" in a && "confidence" in a && "judge_model" in a && "usage" in a, id + " 四件套缺一：" + s);
      }
    } else if (v.ok === true) {
      assert.ok("value" in v && "confidence" in v && "judge_model" in v && "usage" in v, "四件套缺一：" + s);
    } else {
      assert.equal(typeof v.error_kind, "string");
      assert.equal(typeof v.error, "string");
    }
  }
  // 响应里没有 answers.q 时也要给出 parse 错误，而不是 ok:true + undefined
  const bad = JSON.parse(toJudgeJson({ ok: true, data: { model: "m", answers: {} } }, "q"));
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, "parse");
  // 非 JSON 响应体
  const notJson = await jevWith(stubFetch("<html>502</html>", 200)).call("x", Q_NOUL, null);
  assert.equal(notJson.kind, "parse");
  // 网络异常
  const boom = await jevWith(async () => { throw new Error("ECONNREFUSED"); }).call("x", Q_NOUL, null);
  assert.equal(boom.kind, "network");
  assert.ok(boom.error.includes("ECONNREFUSED"));
  // noul 之外的类型 confidence 原样透传
  assert.equal(compactAnswer("q", { type: "choice", choice: "a", confidence: 0 }, { model: "m" }).confidence, 0);
  assert.equal(errorJson("x", "y", { status: 400 }), '{"ok":false,"error_kind":"x","error":"y","status":400}');
  assert.equal(truncateText("abcdef", 3), "abc…（已截断，共 6 字符）");
  ok("返回值恒为合法 JSON；失败分支（parse / network / 缺 answers）都被显式覆盖");
}

// ── 15. 网络失败必须透出 cause 链（宿主代理挂掉时不能只报 fetch failed）──
{
  const refused = Object.assign(new Error("fetch failed"), {
    name: "TypeError",
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7897"), {
      code: "ECONNREFUSED", address: "127.0.0.1", port: 7897,
    }),
  });
  const chain = errorChainText(refused);
  assert.ok(chain.includes("fetch failed"), "缺外层消息：" + chain);
  assert.ok(chain.includes("ECONNREFUSED") && chain.includes("127.0.0.1:7897"), "缺真因：" + chain);
  assert.ok(chain.includes("←"), "cause 没接到外层后面：" + chain);

  // 一次 fetch 同时打多个地址时 undici 会包一层 AggregateError
  const multi = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new AggregateError([refused.cause], "all failed"), { code: "ECONNREFUSED" }),
  });
  assert.ok(errorChainText(multi).includes("127.0.0.1:7897"), "AggregateError 里的原因没取到");
  assert.ok(errorChainText(multi).includes("all failed"), "AggregateError 自己的消息没取到");

  // cause 自引用不能死循环
  const cyc = new Error("self");
  cyc.cause = cyc;
  assert.equal(errorChainText(cyc), "self");

  assert.ok(/没有服务在监听/.test(networkHint(chain)), "ECONNREFUSED 没给出处置提示");
  assert.equal(networkHint("fetch failed"), "", "无特征时不该硬编提示");

  // 端到端：桩 fetch 抛 undici 形状的错，call() 的 error 里必须带真因
  const boom = await jevWith(async () => { throw refused; }).call("x", Q_NOUL, null);
  assert.equal(boom.kind, "network");
  assert.ok(boom.error.includes("ECONNREFUSED 127.0.0.1:7897"), "call() 没透出 cause：" + boom.error);
  assert.ok(boom.error.includes("没有服务在监听"), "call() 没给处置提示：" + boom.error);
  ok("网络失败透出 cause 链 + 处置提示；AggregateError 与自引用都不炸");
}

console.log("\ntest/jev.test.js：" + passed + " 组断言全部通过。");
