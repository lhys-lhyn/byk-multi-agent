/**
 * 后台任务的落盘存储。
 *
 * byk_role 传 background:true 时主控不再等待，助手在宿主进程里继续跑；结果写磁盘，
 * 由 byk_status 取回。为什么落盘：主控的 run_code 有 600 秒硬顶，工具调用也可能被中断，
 * 只有文件能跨过这些边界。任务根目录 <bykRoot>/.byk-work/bg-tasks/（.gitignore 已排除
 * .byk-work/），不写 %TEMP% —— 那里的 dsh-* 目录由宿主沙箱管理，删掉会让会话坏死。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 后台任务根目录。 */
export function bgRoot(bykRoot) { return join(bykRoot, ".byk-work", "bg-tasks"); }

/** 单个任务目录。 */
export function bgTaskDir(bykRoot, taskId) { return join(bgRoot(bykRoot), taskId); }

/** 生成任务 id：<UTC 时间戳>-<角色>-<4 位随机>，字典序即时间序。 */
export function newTaskId(role, now) {
  const at = typeof now === "number" ? now : Date.now();
  const stamp = new Date(at).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rnd = Math.random().toString(36).slice(2, 6);
  return stamp + "-" + role + "-" + rnd;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** 建任务目录并写 meta.json（status=running）。 */
export function initTask(bykRoot, taskId, meta) {
  const dir = bgTaskDir(bykRoot, taskId);
  mkdirSync(dir, { recursive: true });
  const payload = Object.assign({ taskId: taskId, status: "running", startedAt: new Date().toISOString() }, meta || {});
  writeFileSync(join(dir, "meta.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  return dir;
}

/** 写 result.json 并回填 meta 状态（done / failed）。 */
export function finishTask(bykRoot, taskId, result) {
  const dir = bgTaskDir(bykRoot, taskId);
  const r = result || {};
  const out = {
    ok: !!r.ok, role: String(r.role || ""), model: String(r.model || ""),
    duration_s: typeof r.duration_s === "number" ? r.duration_s : 0,
    text: String(r.text === undefined || r.text === null ? "" : r.text),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  const meta = readJson(join(dir, "meta.json"));
  if (meta) {
    meta.status = out.ok ? "done" : "failed";
    meta.finishedAt = new Date().toISOString();
    if (out.model) meta.model = out.model;
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }
  return dir;
}

/** 列出全部任务（按开始时间升序）。 */
export function listTasks(bykRoot) {
  const root = bgRoot(bykRoot);
  if (!existsSync(root)) return [];
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const meta = readJson(join(dir, "meta.json")) || { taskId: e.name };
    const res = readJson(join(dir, "result.json"));
    out.push({
      taskId: e.name,
      role: String(meta.role || ""),
      model: String((res && res.model) || meta.model || ""),
      status: res ? (res.ok ? "done" : "failed") : String(meta.status || "running"),
      startedAt: String(meta.startedAt || ""),
      duration_s: res && typeof res.duration_s === "number" ? res.duration_s : null,
      dir: dir,
    });
  }
  out.sort(function (a, b) { return String(a.startedAt).localeCompare(String(b.startedAt)); });
  return out;
}

/** 读一个任务：meta + result + 结果文本（超长截断并给出完整文件路径）。 */
export function readTask(bykRoot, taskId, limit) {
  const cap = typeof limit === "number" && limit > 0 ? limit : 20000;
  const dir = bgTaskDir(bykRoot, taskId);
  const meta = readJson(join(dir, "meta.json"));
  const res = readJson(join(dir, "result.json"));
  if (!meta && !res) return { found: false };
  const text = res ? String(res.text || "") : "";
  const clipped = text.length > cap
    ? text.slice(0, cap) + "\n\n[已截断：原文 " + text.length + " 字符，完整内容见 " + join(dir, "result.json") + "]"
    : text;
  return { found: true, meta: meta || { taskId: taskId }, result: res, text: clipped, dir: dir };
}

/** 只保留最近 keep 个任务，更早的整个目录删掉。 */
export function pruneTasks(bykRoot, keep) {
  const n = typeof keep === "number" && keep > 0 ? keep : 30;
  const tasks = listTasks(bykRoot);
  const stale = tasks.slice(0, Math.max(0, tasks.length - n));
  const removed = [];
  for (const t of stale) {
    try { rmSync(t.dir, { recursive: true, force: true }); removed.push(t.taskId); } catch { /* 删不掉就留着 */ }
  }
  return removed;
}
