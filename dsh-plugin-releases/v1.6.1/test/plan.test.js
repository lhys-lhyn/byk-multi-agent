/**
 * 计划层单测：解析、规范化、依赖分批、计划书渲染。不依赖 DSH 运行时。
 * 运行：node test/plan.test.js
 */
import assert from "node:assert/strict";
import { parsePlan, normalizePlan, planBatches, formatPlanText, formatProgressText, totalEstimate, ROLE_IDS, PLAN_INSTRUCTION } from "../lib/plan.js";

const FENCE = String.fromCharCode(96).repeat(3);

// 1) 解析：整体 JSON
const a = parsePlan('{"goal":"g","steps":[]}');
assert.equal(a.ok, true);
assert.equal(a.plan.goal, "g");
console.log("1 纯 JSON 解析 OK");

// 2) 解析：围栏 + 前后废话
const b = parsePlan("好的，计划如下：\n" + FENCE + "json\n{\"goal\":\"g2\",\"steps\":[{\"id\":\"s1\"}]}\n" + FENCE + "\n请确认。");
assert.equal(b.ok, true);
assert.equal(b.plan.steps[0].id, "s1");
console.log("2 围栏解析 OK");

// 3) 解析：裸对象夹在文字里（含字符串内的花括号）
const c = parsePlan('先说结论 {"goal":"g3","steps":[{"id":"s1","title":"a}b"}],"notes":"x"} 完。');
assert.equal(c.ok, true);
assert.equal(c.plan.steps[0].title, "a}b");
console.log("3 平衡括号解析 OK");

// 4) 解析：没有 JSON
const d = parsePlan("我不会 JSON");
assert.equal(d.ok, false);
assert.match(d.error, /JSON/);
console.log("4 无 JSON 正确报错 OK");

// 5) 规范化：角色不合法 / 缺 task / 依赖清洗 / 补 id
const norm = normalizePlan({
  goal: "目标",
  steps: [
    { role: "writer", title: "写东西" },
    { id: "s2", role: "code", task: "干活", depends_on: ["s1", "nope", "s2"] },
  ],
}, { roles: ROLE_IDS });
assert.equal(norm.plan.steps[0].id, "s1");
assert.equal(norm.plan.steps[0].role, "task");
assert.equal(norm.plan.steps[0].task, "写东西");
assert.deepEqual(norm.plan.steps[1].depends_on, ["s1"]);
assert.ok(norm.problems.some((p) => /角色/.test(p)));
assert.ok(norm.problems.some((p) => /依赖/.test(p)));
console.log("5 规范化 OK：" + norm.problems.length + " 条提醒");

// 6) 循环依赖被拆掉
const cyc = normalizePlan({
  goal: "环",
  steps: [
    { id: "a", role: "code", task: "A", depends_on: ["b"] },
    { id: "b", role: "code", task: "B", depends_on: ["a"] },
  ],
}, { roles: ROLE_IDS });
assert.ok(cyc.problems.some((p) => /循环依赖/.test(p)));
assert.deepEqual(cyc.plan.steps[0].depends_on, []);
assert.deepEqual(cyc.plan.steps[1].depends_on, []);
console.log("6 循环依赖 OK");

// 7) 分批：纯串行链 -> 3 批各 1 条
const chain = { goal: "链", steps: [
  { id: "s1", role: "code", task: "1", depends_on: [], acceptance: "" },
  { id: "s2", role: "code", task: "2", depends_on: ["s1"], acceptance: "" },
  { id: "s3", role: "code", task: "3", depends_on: ["s2"], acceptance: "" },
] };
const b1 = planBatches(chain, { maxParallel: 3 });
assert.equal(b1.batches.length, 3);
assert.deepEqual(b1.batches.map((x) => x.length), [1, 1, 1]);
console.log("7 串行分批 OK");

// 8) 分批：5 条无依赖 + 上限 2 -> 3 批 [2,2,1]
const flat = { goal: "平", steps: [1, 2, 3, 4, 5].map((n) => ({ id: "s" + n, role: "code", task: "t" + n, depends_on: [], acceptance: "" })) };
const b2 = planBatches(flat, { maxParallel: 2 });
assert.deepEqual(b2.batches.map((x) => x.length), [2, 2, 1]);
assert.deepEqual(b2.blocked, []);
console.log("8 并发布批 OK");

// 9) 分批：菱形依赖 s1 -> (s2,s3) -> s4
const dia = { goal: "菱", steps: [
  { id: "s1", role: "code", task: "1", depends_on: [] },
  { id: "s2", role: "code", task: "2", depends_on: ["s1"] },
  { id: "s3", role: "search", task: "3", depends_on: ["s1"] },
  { id: "s4", role: "code", task: "4", depends_on: ["s2", "s3"] },
] };
const b3 = planBatches(dia, { maxParallel: 3 });
assert.deepEqual(b3.batches.map((x) => x.map((y) => y.id)), [["s1"], ["s2", "s3"], ["s4"]]);
console.log("9 菱形依赖分批 OK");

// 10) 计划书 + 预计 + 进度行
const plan10 = { goal: "把活干完", steps: [
  { id: "s1", title: "写代码", role: "code", task: "写一个文件", acceptance: "文件存在", depends_on: [], estimate_min: 5 },
  { id: "s2", title: "验收", role: "code", task: "验收", acceptance: "", depends_on: ["s1"], estimate_min: 3 },
], notes: "需要先给路径" };
const txt10 = formatPlanText(plan10, ["示例提醒"]);
assert.match(txt10, /执行计划/);
assert.match(txt10, /代码助手/);
assert.match(txt10, /预计合计 8 分钟/);
assert.match(txt10, /验收标准|验收：文件存在/);
assert.match(txt10, /示例提醒/);
assert.equal(totalEstimate(plan10), 8);
assert.equal(formatProgressText(2, 5), "进度 2/5（40%）");
assert.match(formatProgressText(0, 0), /0\/0/);
console.log("10 计划书/预计/进度行 OK");

// 11) 规划指令必须点名判断先行（byk_judge），且既有 JSON 字段仍在
assert.match(PLAN_INSTRUCTION, /byk_judge/);
assert.match(PLAN_INSTRUCTION, /acceptance/);
assert.match(PLAN_INSTRUCTION, /depends_on/);
console.log("11 规划指令含判断先行（byk_judge）OK");

console.log("计划层测试全部通过");
