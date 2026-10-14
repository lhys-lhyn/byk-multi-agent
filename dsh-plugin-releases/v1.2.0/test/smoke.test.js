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

// 1) 防递归
const nested = await role.execute({ role: "vision", task: "看图" }, exec(1));
assert.equal(nested.ok, false);
assert.match(nested.text, /拒绝调用/);
console.log("1 防递归 OK：" + nested.text.slice(0, 40));

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
assert.equal(localRes.ok, true, localRes.text);
assert.match(localRes.text, /本地后端/);
assert.match(localRes.text, /LOCAL_OK/);
console.log("6 本地后端 OK：" + localRes.text.split("\n")[0]);

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

const bad = await batchTool.execute({ plan: "这不是 JSON" }, exec(0));
assert.equal(bad.ok, false);
assert.match(bad.text, /合法 JSON/);
const cycles = await batchTool.execute({ plan: JSON.stringify({ goal: "环", steps: [
  { id: "a", role: "code", task: "A", depends_on: ["b"] },
  { id: "b", role: "code", task: "B", depends_on: ["a"] },
] }) }, exec(0));
assert.equal(cycles.ok, true, cycles.text);
assert.match(cycles.text, /循环依赖/);
console.log("8 坏计划被挡 + 循环依赖有提醒 OK");

console.log("冒烟测试全部通过");