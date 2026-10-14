/**
 * 峰谷判定 + 路由单元测试。运行：node test/timing.test.js
 * 峰谷口径已用 switch-dsh-model.ps1 的 -Status -Port 1（只读）交叉验证 7 个时刻，全部一致。
 */
import assert from "node:assert/strict";
import { isPeakTime, nextPeakChange, describePhase } from "../lib/timing.js";
import { resolveRoute, formatRoute, resolveLocalCommand, loadConfigFile } from "../lib/routing.js";

function bj(y, m, d, hh, mm = 0) {
  return Date.UTC(y, m - 1, d, hh - 8, mm, 0) / 1000;
}

const cases = [
  ["2026-10-09 09:00 周五 高峰起点", bj(2026, 10, 9, 9, 0), true],
  ["2026-10-09 11:59 周五 高峰末尾", bj(2026, 10, 9, 11, 59), true],
  ["2026-10-09 12:00 周五 午休", bj(2026, 10, 9, 12, 0), false],
  ["2026-10-09 13:59 周五 午后", bj(2026, 10, 9, 13, 59), false],
  ["2026-10-09 14:00 周五 下午高峰起点", bj(2026, 10, 9, 14, 0), true],
  ["2026-10-09 17:59 周五 高峰末尾", bj(2026, 10, 9, 17, 59), true],
  ["2026-10-09 18:00 周五 高峰结束", bj(2026, 10, 9, 18, 0), false],
  ["2026-10-10 10:00 周六 周末谷价", bj(2026, 10, 10, 10, 0), false],
  ["2026-10-11 15:00 周日 周末谷价", bj(2026, 10, 11, 15, 0), false],
  ["2026-10-12 10:00 周一 高峰", bj(2026, 10, 12, 10, 0), true],
  ["2026-10-01 10:00 国庆 法定节假日谷价", bj(2026, 10, 1, 10, 0), false],
  ["2026-10-07 16:00 国庆最后一天 谷价", bj(2026, 10, 7, 16, 0), false],
  ["2026-10-08 10:00 节后首个工作日 高峰", bj(2026, 10, 8, 10, 0), true],
  ["2026-09-25 10:00 中秋 谷价", bj(2026, 9, 25, 10, 0), false],
  ["2026-08-19 10:00 旧规则（周末谷价生效前）周三 高峰", bj(2026, 8, 19, 10, 0), true],
  ["2026-08-23 10:00 周日 周末谷价生效当天", bj(2026, 8, 23, 10, 0), false],
];

const peakSec = bj(2026, 10, 9, 10, 0);
const valleySec = bj(2026, 10, 9, 20, 0);

let failed = 0;
for (const [label, sec, expected] of cases) {
  const actual = isPeakTime(sec);
  if (actual !== expected) failed++;
  assert.equal(actual, expected, label);
}
console.log("峰谷用例 " + cases.length + " 个（失败 " + failed + "）");

assert.equal(nextPeakChange(bj(2026, 10, 9, 13, 0)), bj(2026, 10, 9, 14, 0));
assert.equal(nextPeakChange(bj(2026, 10, 9, 18, 30)), bj(2026, 10, 12, 9, 0));
console.log("下次切换：13:00 -> " + describePhase(bj(2026, 10, 9, 13, 0)).nextChange + "；18:30 -> " + describePhase(bj(2026, 10, 9, 18, 30)).nextChange);

const peak = resolveRoute("task", { now: peakSec });
assert.equal(peak.provider, "xiaomi");
assert.equal(peak.model, "mimo-v2.6-flash");
assert.equal(peak.reasoningEffort, undefined);
assert.equal(peak.phase, "peak");
console.log("高峰 task -> " + formatRoute(peak));

const valley = resolveRoute("task", { now: valleySec });
assert.deepEqual(
  { p: valley.provider, m: valley.model, e: valley.reasoningEffort, phase: valley.phase },
  { p: "deepseek-official", m: "deepseek-flash", e: "high", phase: "off-peak" },
);
console.log("低谷 task -> " + formatRoute(valley));

const codePeak = resolveRoute("code", { now: peakSec, registry: { code: { sandbox: "danger-full-access", timeout_s: 3600 } } });
assert.equal(codePeak.model, "mimo-v2.6-flash");
assert.equal(codePeak.sandbox, "danger-full-access");
assert.equal(codePeak.timeoutMs, 3600 * 1000);
console.log("高峰 code（带 registry） -> " + formatRoute(codePeak));

const vision = resolveRoute("vision", { now: peakSec });
assert.equal(vision.model, "mimo-v2.6-flash");
assert.equal(vision.phase, null);
assert.equal(vision.source, "role");
console.log("vision（不参与峰谷） -> " + formatRoute(vision));
console.log("audio -> " + formatRoute(resolveRoute("audio", { now: peakSec })));

const fromReg = resolveRoute("vision", {
  now: peakSec,
  registry: { vision: { provider: "xiaomi", model: "mimo-v2.6", persona: "P", timeout_s: 300 } },
  config: { rolesFrom: "registry" },
});
assert.equal(fromReg.model, "mimo-v2.6");
assert.equal(fromReg.persona, "P");
assert.equal(fromReg.timeoutMs, 300000);
console.log("rolesFrom=registry 的 vision -> " + formatRoute(fromReg) + "（persona 继承）");

const stillRouted = resolveRoute("task", {
  now: peakSec,
  registry: { task: { provider: "xiaomi", model: "mimo-v2.6", timeout_s: 1800 } },
  config: { rolesFrom: "registry" },
});
assert.equal(stillRouted.model, "mimo-v2.6-flash");
console.log("rolesFrom=registry 但 task 仍走峰谷 -> " + formatRoute(stillRouted));

const custom = resolveRoute("search", {
  now: valleySec,
  config: { routing: { appliesTo: ["search"], offPeak: { provider: "volcengine-ark", model: "deepseek-v4-1-flash-260910" } } },
});
assert.equal(custom.provider, "volcengine-ark");
console.log("自定义 appliesTo/offPeak -> " + formatRoute(custom));

const local = resolveLocalCommand("file", {
  task: "D:\\x\\a.pdf",
  config: { local: { enabled: true, command: "python", args: ["-m", "my_extract", "--path", "{task}"], timeoutMs: 120000 } },
});
assert.deepEqual(local, { command: "python", args: ["-m", "my_extract", "--path", "D:\\x\\a.pdf"], cwd: undefined, timeoutMs: 120000 });
assert.throws(() => resolveLocalCommand("file", { config: { local: { enabled: false } } }), /本地后端未启用/);
console.log("本地后端命令 -> python -m my_extract --path D:\\x\\a.pdf");

assert.throws(
  () => resolveRoute("task", { now: peakSec, config: { roles: { task: { provider: "xiaomi", model: "mimo-v2.6-pro" } }, routing: { appliesTo: [] } } }),
  /forbidden model/,
);
console.log("禁用模型被拦下");

const research = resolveRoute("research", { now: peakSec });
assert.equal(research.provider, "xiaomi");
assert.equal(research.model, "mimo-v2.6-pro");
assert.equal(research.phase, null);
assert.equal(research.source, "role");
console.log("research（固定 mimo-v2.6-pro，不随峰谷） -> " + formatRoute(research));

const audio = resolveRoute("audio", { now: peakSec });
assert.equal(audio.backend, "asr");
assert.equal(audio.model, "mimo-v2.5-asr");
assert.equal(audio.understand.model, "mimo-v2.6-flash");
console.log("audio（直连 ASR） -> " + formatRoute(audio));

const example = loadConfigFile(new URL("../agents.config.example.json", import.meta.url).pathname.replace(/^\//, ""));
assert.deepEqual(example.routing.appliesTo, ["task", "code", "search"]);
assert.equal(example.roles.audio.backend, "asr");
assert.equal(example.roles.research.model, "mimo-v2.6-pro");
assert.equal(example.roles.file.backend, "local");
console.log("agents.config.example.json 可读且 appliesTo=" + example.routing.appliesTo.join("/"));

if (failed) {
  console.error(failed + " 个峰谷用例失败");
  process.exit(1);
}
console.log("全部通过");
