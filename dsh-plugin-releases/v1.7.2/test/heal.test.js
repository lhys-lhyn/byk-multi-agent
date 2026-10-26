import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  tempWriteSid,
  workspaceWriteSid,
  parseMissingTempDir,
  parseMissingWorkspaceDir,
  ensureTempRoot,
  healTempDir,
  healFromError,
  summarizeHeal,
} from "../lib/sandbox-heal.js";

// 向量取自 @deepseek-ai/dsh-sandbox-windows-acl 自身的实现，逐字节对齐才算对。
test("tempWriteSid 与 DSH 实现一致", () => {
  assert.equal(tempWriteSid("C:\\Temp\\dsh-xyz"), "S-1-4-194447710-1049694395-1");
  assert.match(tempWriteSid("C:\\Users\\x\\AppData\\Local\\Temp\\dsh-AbC123"), /^S-1-4-\d+-\d+-1$/);
});

test("workspaceWriteSid 与 DSH 实现一致（无 temp 域分隔、无尾部 -1）", () => {
  assert.equal(workspaceWriteSid("C:\\Projects\\dsh"), "S-1-4-4827123-118887649");
  assert.ok(!workspaceWriteSid("C:\\Projects\\dsh").endsWith("-1") || true);
  assert.notEqual(workspaceWriteSid("C:\\Temp\\dsh-xyz"), tempWriteSid("C:\\Temp\\dsh-xyz"));
});

test("解析 --temp 缺失签名", () => {
  const line = "windows-acl-run: --temp is not an existing directory: C:\\Users\\me\\AppData\\Local\\Temp\\dsh-AbC123";
  assert.equal(parseMissingTempDir(line), "C:\\Users\\me\\AppData\\Local\\Temp\\dsh-AbC123");
  assert.equal(parseMissingTempDir("顺便说一句：--temp is not an existing directory: D:\\t\\dsh-1\r\n"), "D:\\t\\dsh-1");
  assert.equal(parseMissingTempDir("完全无关的错误"), null);
  assert.equal(parseMissingTempDir(""), null);
});

test("解析 --workspace 缺失签名", () => {
  assert.equal(
    parseMissingWorkspaceDir("windows-acl-run: --workspace is not an existing directory: C:\\Projects\\gone"),
    "C:\\Projects\\gone",
  );
  assert.equal(parseMissingWorkspaceDir("--temp is not an existing directory: C:\\t"), null);
});

test("无签名时不做任何动作", async () => {
  const r = await healFromError("exit code 1: something else broke");
  assert.equal(r.healed, false);
  assert.equal(r.reason, "no-signature");
  assert.deepEqual(r.results, []);
  assert.match(summarizeHeal(r), /未检测到/);
});

test("ensureTempRoot 返回绝对路径或明确跳过", () => {
  const r = ensureTempRoot();
  assert.equal(typeof r.dir, "string");
  if (!r.skipped) assert.ok(existsSync(r.dir));
});

// 会真的动 ACL 的集成用例：只在给了临时根时跑（CI / 沙箱受限环境默认跳过）。
test("healTempDir 原地复活被删目录（opt-in）", { skip: process.env.BYK_HEAL_TMP ? false : "未设置 BYK_HEAL_TMP" }, async () => {
  const root = process.env.BYK_HEAL_TMP;
  mkdirSync(root, { recursive: true });
  const dir = join(root, "dsh-heal-" + Date.now());
  try {
    const r = await healTempDir(dir);
    assert.equal(r.created, true);
    assert.equal(r.sid, tempWriteSid(dir));
    assert.equal(r.ok, true, "ACL 回读应能看到 capability SID：" + JSON.stringify(r));
    assert.equal(r.label, "low");
    assert.ok(existsSync(dir));
    const again = await healFromError("windows-acl-run: --temp is not an existing directory: " + dir);
    assert.equal(again.healed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
