/**
 * 冒烟测试：用假 ctx 真正加载 lib/index.js，验证注册、路由分派、防递归、本地后端、ASR 缺路径。
 * 运行：node test/smoke.test.js   （需要 bykRoot 下能跑 python -m byk.cli roles --json）
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, apply, inject, name } from "../lib/index.js";

const BYK_ROOT = process.env.BYK_ROOT || "C:/Projects/byk";
const PYTHON = process.env.BYK_PYTHON || BYK_ROOT + "/.venv/Scripts/python.exe";
const NODE = process.execPath;

const toolsByName = new Map();
const sections = [];
const starts = [];
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  systemPrompt: {
    getSectionOrder: () => 50,
    section: (o) => { sections.push(o); return () => {}; },
  },
  tools: { register: (t) => { toolsByName.set(t.name, t); return () => {}; } },
  subagents: {
    list: () => ["spawn", "fork"],
    getProvider: () => ({ capabilities: { agentOptions: true, persona: true } }),
    start: async (providerName, req) => {
      starts.push({ providerName, req });
      const o = req.agentOptions || {};
      const promptText = (req.prompt || []).map((x) => (x && x.text) || "").join("\n");
      let text = "子智能体回复 " + o.provider + "/" + o.model + " effort=" + String(o.reasoningEffort);
      // 规划调用：任务助手必须回结构化 JSON
      if (promptText.includes("只输出一个 JSON 对象")) {
        text = JSON.stringify({
          goal: "把插件的说明更新好",
          steps: [
            { id: "s1", title: "读现有说明", role: "code", task: "读 readme.md 并列出要改的点", acceptance: "给出清单", depends_on: [], estimate_min: 3 },
            { id: "s2", title: "查外部资料", role: "search", task: "查同类插件的说明写法", acceptance: "给出来源链接", depends_on: ["s1"], estimate_min: 5 },
            { id: "s3", title: "改说明", role: "code", task: "按清单改 readme.md", acceptance: "readme.md 已更新", depends_on: ["s2"], estimate_min: 5 },
          ],
          notes: "需要用户先确认",
        });
      }
      return { result: Promise.resolve({ output: [{ type: "text", text }], stopReason: "completed" }), dispose: async () => {} };
    },
  },
};

assert.equal(name, "byk-agents");
assert.deepEqual(inject, ["tools", "subagents", "systemPrompt"]);
assert.ok(Config, "要导出 Config");

const cfg = { bykRoot: BYK_ROOT, python: PYTHON, timeoutMs: 60000 };
apply(ctx, cfg);
assert.ok(sections.some((s) => s.name === "byk:workflow"), "应注入协作流程");
assert.ok(sections.find((s) => s.name === "byk:workflow").text.includes("助手调用清单"), "协作流程要含助手调用清单");
assert.ok(toolsByName.has("byk_role"), "要注册 byk_role");
assert.ok(toolsByName.has("byk_hire"), "要注册 byk_hire");

const role = toolsByName.get("byk_role");
assert.equal(typeof role.presentCall, "function");
assert.equal(typeof role.presentResult, "function");

const exec = (depth = 0) => ({ signal: undefined, agent: { session: { header: { delegationDepth: depth } } } });

// ── 第 1 节的前置条件：角色注册表必须可读 ────────────────────────────────
// 为什么要有这一段：byk_role 每次调用都现场跑 `<python> -m byk.cli roles --json`
// （lib/index.js:361 loadRegistry），而 lib/index.js:415 的 runRole 在**路由与防递归之前**
// 就无条件读它。第 1 节据此断言"防递归"，第 6/7/8 节也全都经 runRole
// （本地后端 :415、byk_plan :682、byk_batch :768）。所以在受限环境里
// （管道 stdio 被禁 → spawn EPERM，或 python 路径不对 → ENOENT）这些用例拿到的
// 都是「无法读取角色定义：…」—— 这是环境问题，不是插件行为出错。
// 因此把"注册表能不能读"抽成显式前置条件：读不到就打印 SKIP 行并跳过该节，绝不把环境问题
// 变成 AssertionError；读得到时各节原有断言逐字保留，仍是硬断言（失败即失败）。
const REGISTRY_UNREADABLE = /无法读取角色定义/;
/** 本次运行因环境跳过的 SKIP 行（收尾汇总用；第 10 节的桩调用不计入）。 */
const skipEvents = [];

/** 打印一行跳过原因，格式固定 `SKIP: role registry unreadable: <原始错误信息>`。 */
function skipNote(reason, log = console.log) {
  const line = "SKIP: role registry unreadable: " + reason;
  log(line);
  // 第 10 节注入的是收集器，只用来断言打印内容，不计入本次运行的环境跳过统计
  if (log === console.log) skipEvents.push(line);
  return true;
}

/** 去掉插件自己的中文前缀，只留底层原始错误（退出码 / spawn EPERM / ENOENT …）。 */
function rawRegistryError(text) {
  return String(text).replace(/^.*?无法读取角色定义：?/, "");
}

/** 这个结果是不是"注册表读不到"（环境问题），而不是角色真的被调用/被拒绝。 */
function isRegistryUnreadableResult(res) {
  return !!res && res.ok === false && REGISTRY_UNREADABLE.test(String(res.text));
}

/** 探测一次注册表是否可读。可读时顺带返回 depth=1 的调用结果（它就是防递归的答案，不必再跑一次）。 */
async function probeRegistryForRecursionGuard() {
  const res = await role.execute({ role: "vision", task: "看图" }, exec(1));
  if (isRegistryUnreadableResult(res)) return { ok: false, error: rawRegistryError(res.text) };
  return { ok: true, result: res };
}

/**
 * 第 1 节「防递归」。前置条件不成立 → 打印跳过原因并返回 { skipped: true }，不抛 AssertionError。
 * @param probeFn 注册表探测函数；第 10 节注入"读失败"的桩来验证跳过路径本身
 * @param log 输出函数；默认 console.log，第 10 节换成收集器以断言打印内容
 * @returns {Promise<{skipped: boolean, reason?: string}>}
 */
async function section1RecursionGuard(probeFn = probeRegistryForRecursionGuard, log = console.log) {
  let probe;
  try {
    probe = await probeFn();
  } catch (err) {
    // 探测本身炸了（如 spawn 同步抛错）同样按"注册表不可读"处理，别把环境异常当断言失败
    probe = { ok: false, error: String((err && err.message) || err) };
  }
  if (!probe.ok) {
    skipNote(probe.error, log);
    return { skipped: true, reason: probe.error };
  }
  assert.equal(probe.result.ok, false);
  assert.match(probe.result.text, /拒绝调用/);
  log("1 防递归 OK：" + probe.result.text.slice(0, 40));
  return { skipped: false };
}

const guard = await section1RecursionGuard();
// 显式前置条件（第 1/6/7/8 节共用）：角色注册表可读。
// 注意：第 2-5 节自己另有一个 let registryOk 探测（本文件下方），此处换个名字以免重名。
// registryReadable=false 时下面各节只打印 SKIP 并跳过，不做断言。
const registryReadable = !guard.skipped;
const registryReadableReason = guard.reason || "";

// 2) 角色分派（需要注册表可读；读不到就跳过）
let registryOk = true;
try {
  const probe = await role.execute({ role: "vision", task: "看图" }, exec(0));
  if (!probe.ok && /无法读取角色定义/.test(probe.text)) registryOk = false;
  else {
    assert.equal(probe.ok, true, probe.text);
    assert.match(probe.text, /mimo-v2\.6-flash/);
    const v = starts.at(-1);
    assert.equal(v.req.agentOptions.provider, "xiaomi");
    assert.equal(v.req.agentOptions.model, "mimo-v2.6-flash");
    assert.equal(v.req.agentOptions.reasoningEffort, undefined);
    console.log("2 vision 分派 OK：" + probe.text.split("\n")[0]);

    const res = await role.execute({ role: "research", task: "综述" }, exec(0));
    assert.equal(res.ok, true, res.text);
    assert.equal(starts.at(-1).req.agentOptions.model, "mimo-v2.6-pro");
    console.log("3 research 固定模型 OK：" + res.text.split("\n")[0]);

    const audio = await role.execute({ role: "audio", task: "帮我转写这段录音" }, exec(0));
    assert.equal(audio.ok, false);
    assert.match(audio.text, /绝对路径/);
    console.log("4 audio 缺路径被挡住 OK");

    const call = role.presentCall({ role: "vision", task: "x" });
    assert.equal(call.title, "助手：vision");
    const pv = role.presentResult({ role: "vision" }, { value: { ok: true, role: "vision", model: "xiaomi/mimo-v2.6-flash ｜高峰", duration_s: 1.23, text: "结论" } });
    assert.match(pv.title, /助手 vision · xiaomi\/mimo-v2\.6-flash/);
    assert.match(pv.title, /完成/);
    console.log("5 结果卡片 OK：" + pv.title);
  }
} catch (err) {
  if (/无法读取角色定义|spawn|ENOENT/.test(String(err && err.message))) registryOk = false;
  else throw err;
}
if (!registryOk) console.log("2-5 跳过：读不到 BYK 角色注册表（设 BYK_ROOT / BYK_PYTHON 后重跑）");

// 6) 本地后端：走配置文件里的 roles.file.local，不调用任何模型
const tmp = mkdtempSync(join(tmpdir(), "byk-smoke-"));
const cfgPath = join(tmp, "agents.config.json");
writeFileSync(cfgPath, JSON.stringify({
  roles: { file: { backend: "local", local: { enabled: true, command: NODE, args: ["-e", "console.log(\"LOCAL_OK\")"] } } },
}), "utf8");
const ctx2 = { ...ctx, tools: { register: (t) => toolsByName.set(t.name, t) } };
toolsByName.delete("byk_role");
apply(ctx2, { bykRoot: BYK_ROOT, python: PYTHON, timeoutMs: 60000, routingConfigPath: cfgPath });
const localRes = await toolsByName.get("byk_role").execute({ role: "file", task: "任意" }, exec(0));
// 本地后端自己不起模型，但 runRole 在路由前就无条件读注册表，所以读不到时这里也只是环境受限。
if (!registryReadable) {
  skipNote(registryReadableReason);
} else {
  assert.equal(localRes.ok, true, localRes.text);
  assert.match(localRes.text, /本地后端/);
  assert.match(localRes.text, /LOCAL_OK/);
  console.log("6 本地后端 OK：" + localRes.text.split("\n")[0]);
}

// 7) 计划层接到工具上：byk_plan 出计划、byk_batch 按依赖并发执行
//    沿用第 6 步的配置（rolesFrom=routing，默认角色表齐备，不依赖 python 注册表）。
const planTool = toolsByName.get("byk_plan");
const batchTool = toolsByName.get("byk_batch");
assert.ok(planTool, "要注册 byk_plan");
assert.ok(batchTool, "要注册 byk_batch");
assert.equal(typeof planTool.presentCall, "function");
assert.equal(typeof batchTool.presentResult, "function");

const emptyReq = await planTool.execute({ request: "   " }, exec(0));
assert.equal(emptyReq.ok, false);
assert.match(emptyReq.text, /request/);

const startsBefore = starts.length;
// byk_plan（lib/index.js:682）与 byk_batch（lib/index.js:768）都经 runRole，runRole 先读注册表；
// 读不到时它们拿到的就是环境错误。前置条件不成立 → 打印 SKIP 并跳过本节。
if (!registryReadable) {
  skipNote(registryReadableReason);
} else {
  const pl = await planTool.execute({ request: "把 dsh 插件的 readme 更新一下" }, exec(0));
  assert.equal(pl.ok, true, pl.text);
  assert.equal(pl.step_count, 3, pl.text);
  const planObj = JSON.parse(pl.plan_json);
  assert.equal(planObj.steps.length, 3);
  assert.match(pl.text, /执行计划/);
  assert.match(pl.text, /代码助手|搜索助手/);
  assert.match(pl.text, /任务助手拆分|由任务助手|计划/);
  const planStart = starts[startsBefore];
  assert.match(planStart.req.prompt[0].text, /只输出一个 JSON 对象/);
  console.log("7 byk_plan OK：" + pl.step_count + " 步 · " + pl.model);

  const bt = await batchTool.execute({ plan: pl.plan_json }, exec(0));
  assert.equal(bt.ok, true, bt.text);
  assert.equal(bt.total, 3);
  assert.equal(bt.done, 3);
  assert.equal(bt.failed, 0, bt.text);
  assert.match(bt.text, /助手调用清单/);
  assert.match(bt.text, /各步结论/);
  assert.match(bt.text, /进度 3\/3（100%）/);
  const rows = JSON.parse(bt.results_json);
  assert.deepEqual(rows.map((x) => x.id), ["s1", "s2", "s3"]);
  assert.ok(rows.every((x) => x.ok));
  // 依赖步骤必须看到前置结论
  const s2Prompt = starts.slice(startsBefore + 1).map((s) => s.req.prompt[0].text).find((t) => t.includes("查同类插件的说明写法"));
  assert.ok(s2Prompt, "找不到 s2 的下发提示");
  assert.match(s2Prompt, /前置步骤结论/);
  assert.match(s2Prompt, /子智能体回复 xiaomi\/mimo-v2\.6-flash|子智能体回复 deepseek-official/);
  assert.match(s2Prompt, /验收标准/);
  // 批次顺序：s1 先于 s2，s2 先于 s3
  const order = starts.slice(startsBefore + 1).map((s) => s.req.prompt[0].text);
  assert.ok(order.findIndex((t) => t.includes("读 readme.md")) < order.findIndex((t) => t.includes("查同类插件的说明写法")));
  assert.ok(order.findIndex((t) => t.includes("查同类插件的说明写法")) < order.findIndex((t) => t.includes("按清单改 readme.md")));
  const btTitle = batchTool.presentResult({}, { value: bt }).title;
  assert.match(btTitle, /完成 3\/3/);
  console.log("7 byk_batch OK：" + btTitle);
}

const bad = await batchTool.execute({ plan: "这不是 JSON" }, exec(0));
assert.equal(bad.ok, false);
assert.match(bad.text, /合法 JSON/);
const cycles = await batchTool.execute({ plan: JSON.stringify({ goal: "环", steps: [
  { id: "a", role: "code", task: "A", depends_on: ["b"] },
  { id: "b", role: "code", task: "B", depends_on: ["a"] },
] }) }, exec(0));
// 循环依赖用例的两步同样会被真的执行，前置条件不成立时也只能跳过（注册表可读时逐字仍是硬断言）。
if (!registryReadable) {
  skipNote(registryReadableReason);
  // 本节前半（坏计划被挡）不依赖注册表，上面的硬断言已经跑过；只有后半的循环依赖用例要跳过
  console.log("8 坏计划被挡 OK（循环依赖用例因环境跳过）");
} else {
  assert.equal(cycles.ok, true, cycles.text);
  assert.match(cycles.text, /循环依赖/);
  console.log("8 坏计划被挡 + 循环依赖有提醒 OK");
}


assert.ok(toolsByName.has("byk_judge"), "要注册 byk_judge");
assert.ok(toolsByName.has("byk_judge_batch"), "要注册 byk_judge_batch");
const judgeTool = toolsByName.get("byk_judge");
const judgeBatchTool = toolsByName.get("byk_judge_batch");
for (const k of ["state", "question_type", "question", "criteria"]) {
  assert.ok(judgeTool.parameters && judgeTool.parameters[k], "byk_judge 参数要含 " + k);
}
assert.ok(judgeBatchTool.parameters && judgeBatchTool.parameters.state && judgeBatchTool.parameters.questions, "byk_judge_batch 参数要含 state/questions");
const workflowText = sections.find((x) => x.name === "byk:workflow").text;
assert.match(workflowText, /判断先行/, "协作流程要含「判断先行」");
assert.match(workflowText, /byk_judge/, "协作流程要点名 byk_judge");
console.log("9 byk_judge / byk_judge_batch 已注册 + 判断先行已注入 OK");
// 10) 跳过路径本身可验证：注入"注册表读不到"的桩，断言走 SKIP 且打印了原因。
//     只桩掉探测函数，不碰本机环境：不删注册表、不改 BYK_ROOT、不动 python。
{
  const seen = [];
  const collect = (...args) => seen.push(args.map(String).join(" "));
  const stubbed = await section1RecursionGuard(
    async () => ({ ok: false, error: "spawn EPERM（桩：模拟受限沙箱读不到角色注册表）" }),
    collect,
  );
  assert.equal(stubbed.skipped, true, "桩注入的读失败必须走 skip 分支，而不是抛断言");
  assert.equal(stubbed.reason, "spawn EPERM（桩：模拟受限沙箱读不到角色注册表）");
  const line = seen.find((l) => l.startsWith("SKIP: role registry unreadable: "));
  assert.ok(line, "跳过必须打印原因，实际打印：" + JSON.stringify(seen));
  assert.match(line, /spawn EPERM/, "跳过原因要带原始错误信息");
  assert.equal(seen.length, 1, "跳过路径只该打印这一行，实际：" + JSON.stringify(seen));
  console.log("10 注册表不可读时走 SKIP 且打印原因 OK：" + line);
}

{
  // 探测函数自己抛错（spawn 同步失败等）也按环境问题跳过，不是断言失败
  const threw = [];
  const thrown = await section1RecursionGuard(
    async () => { throw new Error("spawn EPERM（桩：探测函数直接抛）"); },
    (...args) => threw.push(args.map(String).join(" ")),
  );
  assert.equal(thrown.skipped, true, "探测抛错也必须走 skip 分支");
  assert.match(threw.join("\n"), /^SKIP: role registry unreadable: spawn EPERM（桩：探测函数直接抛）$/m);
  console.log("10 探测抛错也走 SKIP OK");
}

{
  // 反例 1：注册表可读、防递归却根本没拦住（调用居然真的派发了）→ 必须硬失败，不被跳过路径吃掉
  await assert.rejects(
    () => section1RecursionGuard(
      async () => ({ ok: true, result: { ok: true, text: "居然真的派发了" } }),
      () => {},
    ),
    (err) => !!err && err.code === "ERR_ASSERTION",
    "注册表可读时防递归必须仍是硬断言（派发成功 → 失败）",
  );
  // 反例 2：拿到的不是防递归拒绝（文本不含「拒绝调用」）→ 同样必须硬失败，且失败点就是那句 /拒绝调用/
  //        这正是缺陷 A 原本的失败点，说明它仍然是有牙齿的硬断言
  await assert.rejects(
    () => section1RecursionGuard(
      async () => ({ ok: true, result: { ok: false, text: "无法读取角色定义：这是可读时不该出现的文本" } }),
      () => {},
    ),
    /拒绝调用/,
    "注册表可读时防递归必须仍是硬断言（文本不匹配 → 失败）",
  );
  console.log("10 注册表可读时防递归仍为硬断言 OK（两条反例都硬失败）");
}

{
  // 反向：结果不是注册表错误时不许被当成环境跳过（防止跳过分支吃掉真失败）
  const seen2 = [];
  const faked = await section1RecursionGuard(
    async () => ({ ok: true, result: { ok: false, text: "拒绝调用：delegationDepth=1" } }),
    (...args) => seen2.push(args.map(String).join(" ")),
  );
  assert.equal(faked.skipped, false, "可读且防递归生效时不许跳过");
  assert.deepEqual(seen2, ["1 防递归 OK：拒绝调用：delegationDepth=1"], "可读时只该打印 OK 行");
  console.log("10 可读时不跳过、照常打印 OK OK");
}

// ── 11) byk_mood：注册、参数/返回 schema，以及协作流程里的情绪小节 ────────
// 与第 9 节同一套路：用假 ctx 真加载 lib/index.js 后查注册表；不需要网络
// （非法 criteria 会在本地被拦下，根本不会发请求）。
{
  assert.ok(toolsByName.has("byk_mood"), "要注册 byk_mood");
  const moodTool = toolsByName.get("byk_mood");
  for (const k of ["state", "criteria"]) {
    assert.ok(moodTool.parameters && moodTool.parameters[k], "byk_mood 参数要含 " + k);
  }
  assert.equal(moodTool.parameters.state.required, true, "state 是必填");
  assert.equal(moodTool.parameters.criteria.type, "json", "criteria 是可选 json（覆盖三问选项）");
  assert.equal(typeof moodTool.presentCall, "function");
  assert.equal(typeof moodTool.presentResult, "function");
  assert.equal(moodTool.output.schema.type, "string", "byk_mood 返回紧凑 JSON 字符串");
  assert.ok(moodTool.timeoutMs > 0, "byk_mood 要有自己的超时（比 jev 内部超时多留余量）");

  // schema 齐全还不够：真调一次 execute，确认覆盖项形状不对时是本地 config 拦截、不发网络
  const badCriteria = JSON.parse(await moodTool.execute({ state: "随便一句话", criteria: { urgency: ["只有一级"] } }, exec(0)));
  assert.equal(badCriteria.ok, false);
  assert.equal(badCriteria.error_kind, "config");
  assert.match(badCriteria.error, /criteria\.urgency/);
  const strayKey = JSON.parse(await moodTool.execute({ state: "x", criteria: { mood: { a: "b" } } }, exec(0)));
  assert.equal(strayKey.ok, false);
  assert.equal(strayKey.error_kind, "config");
  assert.match(strayKey.error, /emotion|urgency|need/);
  console.log("11 byk_mood 已注册 + 参数/返回 schema 齐备 + 非法 criteria 本地拦下 OK");
}

// ── 11b) 协作流程新增的「先读情绪、再排任务」小节与四条边界 ─────────────
{
  const wfEmotion = sections.find((x) => x.name === "byk:workflow").text;
  assert.match(wfEmotion, /先读情绪、再排任务/, "协作流程要含「先读情绪、再排任务」小节标题");
  assert.match(wfEmotion, /byk_mood/, "该小节要点名 byk_mood");
  assert.match(wfEmotion, /不改任务范围与验收标准/, "边界①：只改措辞与呈现顺序，不改范围与验收");
  assert.match(wfEmotion, /弱信号/, "边界②：置信度偏低要如实标注成弱信号");
  assert.match(wfEmotion, /不做无原则附和/, "边界③：不做无原则附和，有代价照样直说");
  assert.match(wfEmotion, /纯事实查证/, "边界④：纯事实查证等情形不触发");
  // 规则必须通用、可迁移：小节里不许把某类具体场景写死成规则
  assert.doesNotMatch(wfEmotion, /省钱/, "情绪小节不许把具体场景（如省钱）写死成规则");
  console.log("11b 情绪小节标题 + 四条边界 + 通用性（查无写死场景）OK");
}

if (skipEvents.length) {
  console.log("冒烟测试结束：" + skipEvents.length + " 处用例因环境跳过（角色注册表不可读），其余用例通过；设 BYK_ROOT / BYK_PYTHON 后重跑可恢复完整覆盖");
} else {
  console.log("冒烟测试全部通过");
}