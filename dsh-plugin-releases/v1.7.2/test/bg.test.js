import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bgRoot, bgTaskDir, newTaskId, initTask, finishTask, listTasks, readTask, pruneTasks } from "../lib/bg.js";

const root = mkdtempSync(join(tmpdir(), "bgtest-"));
let pass = 0;
function it(name, fn) { fn(); console.log("  ok  " + name); pass++; }

it("newTaskId 形如 <时间戳>-<角色>-<4位随机>，且字典序随时间递增", () => {
  const a = newTaskId("code", Date.UTC(2026, 0, 2, 3, 4, 5));
  const b = newTaskId("code", Date.UTC(2026, 0, 2, 3, 4, 6));
  assert.match(a, /^20260102030405-code-[a-z0-9]{4}$/);
  assert.ok(a < b, a + " 应排在 " + b + " 之前");
  assert.match(newTaskId("vision"), /-vision-[a-z0-9]{4}$/);
});

it("initTask 建目录并写 running 的 meta.json", () => {
  const id = "20260102030405-code-aaaa";
  const dir = initTask(root, id, { role: "code", task: "盘点" });
  assert.equal(dir, bgTaskDir(root, id));
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.equal(meta.taskId, id);
  assert.equal(meta.status, "running");
  assert.equal(meta.role, "code");
  assert.ok(meta.startedAt);
});

it("finishTask 写 result.json 并把 meta 改成 done", () => {
  const id = "20260102030406-code-bbbb";
  initTask(root, id, { role: "code" });
  finishTask(root, id, { ok: true, role: "code", model: "deepseek-official/deepseek-flash", duration_s: 12.5, text: "报告正文" });
  const res = JSON.parse(readFileSync(join(bgTaskDir(root, id), "result.json"), "utf8"));
  assert.equal(res.ok, true);
  assert.equal(res.text, "报告正文");
  assert.equal(res.duration_s, 12.5);
  const meta = JSON.parse(readFileSync(join(bgTaskDir(root, id), "meta.json"), "utf8"));
  assert.equal(meta.status, "done");
  assert.equal(meta.model, "deepseek-official/deepseek-flash");
  assert.ok(meta.finishedAt);
});

it("失败的执行也落盘：ok=false 且 meta 状态 failed", () => {
  const id = "20260102030407-code-cccc";
  initTask(root, id, { role: "code" });
  finishTask(root, id, { ok: false, role: "code", model: "", duration_s: 0, text: "被环境阻塞" });
  const got = readTask(root, id);
  assert.equal(got.found, true);
  assert.equal(got.result.ok, false);
  assert.equal(got.meta.status, "failed");
  assert.equal(got.text, "被环境阻塞");
});

it("listTasks 按开始时间升序，状态取自 result 是否存在", () => {
  const tasks = listTasks(root);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.taskId), [
    "20260102030405-code-aaaa",
    "20260102030406-code-bbbb",
    "20260102030407-code-cccc",
  ]);
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks[1].status, "done");
  assert.equal(tasks[2].status, "failed");
  assert.equal(tasks[1].duration_s, 12.5);
});

it("readTask 对不存在的任务返回 found=false", () => {
  assert.equal(readTask(root, "20260102030499-code-zzzz").found, false);
});

it("readTask 超长文本按 limit 截断并给出完整文件路径", () => {
  const id = "20260102030408-code-dddd";
  initTask(root, id, { role: "code" });
  finishTask(root, id, { ok: true, role: "code", model: "m", duration_s: 1, text: "x".repeat(500) });
  const full = readTask(root, id, 100000);
  assert.equal(full.text.length, 500);
  const cut = readTask(root, id, 100);
  assert.equal(cut.text.length > 100, true);
  assert.ok(cut.text.startsWith("x".repeat(100)));
  assert.ok(cut.text.includes("已截断"));
  assert.ok(cut.text.includes("result.json"));
});

it("pruneTasks 只保留最近 keep 个，删除的更早任务目录消失", () => {
  const removed = pruneTasks(root, 2);
  assert.deepEqual(removed, ["20260102030405-code-aaaa", "20260102030406-code-bbbb"]);
  assert.equal(existsSync(bgTaskDir(root, "20260102030405-code-aaaa")), false);
  const left = listTasks(root);
  assert.deepEqual(left.map((x) => x.taskId), ["20260102030407-code-cccc", "20260102030408-code-dddd"]);
  assert.deepEqual(pruneTasks(root, 2), []);
});

it("bgRoot 落在 .byk-work/bg-tasks 下（不写 %TEMP%）", () => {
  assert.ok(bgRoot("C:/x").replace(/\\/g, "/").endsWith("/.byk-work/bg-tasks"));
});

rmSync(root, { recursive: true, force: true });
console.log(pass + " bg 用例全过");
