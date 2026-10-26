/**
 * Windows 沙箱临时目录自愈（BYK 插件 C 包）。
 *
 * 背景：workspace-write 模式下 DSH 的 windows-acl 沙箱会为 (sessionId, workspaceRoot) 分配一个
 * %TEMP%\dsh-XXXX 私有目录，把 capability SID 的写 ACE 与 Low 完整性标签打在它上面，然后把这个
 * 目录缓存在 provider 里（key = JSON.stringify([sessionId, workspaceRoot])）。该目录一旦被删
 * （清理临时文件时最常发生），缓存的路径就悬空，之后每一次沙箱调用都会以
 *     windows-acl-run: --temp is not an existing directory: <绝对路径>
 * 退出码 127 失败，直到宿主重启（重启才会重新 mkdtemp）。
 *
 * 本模块按 DSH 的字节级口径把被删目录原地复活：路径不变 -> tempWriteSid 推导不变 -> 受限令牌里
 * 的 capability SID 依然匹配，于是不重启也能恢复。
 *
 * SID 推导必须与 @deepseek-ai/dsh-sandbox-windows-acl 完全一致：
 *   tempWriteSid(dir)       = S-1-4-(d0 % (2^30-1))+1-(d1 % (2^30-1))+1-1, d = sha256(utf8("temp\0") + utf8(dir))
 *   workspaceWriteSid(root) = S-1-4-(d0 % (2^30-1))+1-(d1 % (2^30-1))+1,   d = sha256(utf8(root))
 *
 * 实现注意（踩过）：icacls 的 /grant 必须把 SID 解析成账户名，capability SID 是合成 SID、没有账户映射，
 * 直接 icacls /grant *S-1-4-... 会报「账户名与安全标识间无任何映射完成」。所以授权走 PowerShell +
 * System.Security.AccessControl（SecurityIdentifier 直接构造，不需要映射）；完整性标签仍用
 * icacls /setintegritylevel（它按 SID 常量处理，不需要映射）。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

const UA = 2 ** 30 - 1;
const PS = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** 与 DSH 一致的私有临时目录 capability SID。 */
export function tempWriteSid(tempDir) {
  const d = createHash("sha256").update("temp\0", "utf8").update(String(tempDir), "utf8").digest();
  return "S-1-4-" + (d.readUInt32LE(0) % UA + 1) + "-" + (d.readUInt32LE(4) % UA + 1) + "-1";
}

/** 与 DSH 一致的工作区 capability SID（本模块只做推导展示，不改工作区 ACL）。 */
export function workspaceWriteSid(workspaceRoot) {
  const d = createHash("sha256").update(String(workspaceRoot), "utf8").digest();
  return "S-1-4-" + (d.readUInt32LE(0) % UA + 1) + "-" + (d.readUInt32LE(4) % UA + 1);
}

const RE_TEMP = /--temp is not an existing directory: (.+)$/m;
const RE_WS = /--workspace is not an existing directory: (.+)$/m;

function cleanPath(raw) {
  return String(raw).trim().replace(/^["']|["']$/g, "").replace(/[.,;)\]]+$/, "");
}

/** 从 stderr/stdout 里解析出缺失的 --temp 路径；无签名返回 null。 */
export function parseMissingTempDir(text) {
  const m = RE_TEMP.exec(String(text || ""));
  return m ? cleanPath(m[1]) : null;
}

/** 从 stderr/stdout 里解析出缺失的 --workspace 路径；无签名返回 null。 */
export function parseMissingWorkspaceDir(text) {
  const m = RE_WS.exec(String(text || ""));
  return m ? cleanPath(m[1]) : null;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs || 25000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          message: err ? String(err.message || "") : "",
        });
      });
  });
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 系统临时根目录；不存在则创建。返回 {dir, exists, created, skipped}。 */
export function ensureTempRoot() {
  const dir = tmpdir();
  const sane = typeof dir === "string" && isAbsolute(dir) && !dir.startsWith("undefined");
  if (!sane) return { dir: String(dir), exists: false, created: false, skipped: "tmpdir-unresolved" };
  const before = existsSync(dir);
  let created = false;
  if (!before) {
    mkdirSync(dir, { recursive: true });
    created = true;
  }
  return { dir, exists: before, created, skipped: "" };
}

function grantScript(dir, sid) {
  // 不用 cmd 拼接：execFile 直接传 -Command，路径用单引号 PS 字面量包。
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=" + psQuote(dir),
    "$acl=Get-Acl -LiteralPath $p",
    "$sid=New-Object System.Security.Principal.SecurityIdentifier " + psQuote(sid),
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl.SetAccessRule($rule)",
    "Set-Acl -LiteralPath $p -AclObject $acl",
    "(Get-Acl -LiteralPath $p).Sddl",
  ].join("; ");
  return script;
}

async function grantBySid(dir, sid) {
  const r = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", grantScript(dir, sid)]);
  return { ok: r.ok, sddl: r.stdout.trim(), stderr: (r.stderr || r.message).trim().slice(0, 400) };
}

/**
 * 原地复活一个被删的私有临时目录：
 *   1) mkdir -p（父目录缺失一起补）
 *   2) PowerShell + SecurityIdentifier 授 capability SID 完全控制（含继承）
 *   3) icacls /setintegritylevel (OI)(CI)Low —— 受限令牌是低完整性，缺标签写不进去
 *   4) 回读 SDDL 校验 SID 真的落到 DACL 上
 * 失败不抛，返回结构化结果交给调用方决定怎么报。
 */
export async function healTempDir(dir, opts = {}) {
  const target = String(dir || "").trim();
  if (!target) return { dir: "", ok: false, reason: "empty-path" };
  const existed = existsSync(target) && statSync(target).isDirectory();
  let created = false;
  try {
    if (!existed) {
      mkdirSync(target, { recursive: true });
      created = true;
    }
  } catch (err) {
    return { dir: target, ok: false, reason: "mkdir-failed", error: String(err.message || err) };
  }
  const sid = tempWriteSid(target);
  const grant = await grantBySid(target, sid);
  const label = await run("icacls", [target, "/setintegritylevel", "(OI)(CI)Low"]);
  const sddlTouchesSid = grant.sddl.toUpperCase().indexOf(sid.toUpperCase()) >= 0;
  return {
    dir: target,
    sid,
    ok: grant.ok && sddlTouchesSid,
    existed,
    created,
    grant: grant.ok ? (sddlTouchesSid ? "granted" : "grant-unverified") : "grant-failed",
    label: label.ok ? "low" : "label-failed",
    aclHasSid: sddlTouchesSid,
    labelHasLow: /Low Mandatory Level|Mandatory Label.*Low/i.test(label.stdout + label.stderr),
    stderr: (grant.stderr + " " + label.stderr).trim().slice(0, 400),
  };
}

/**
 * 从一段错误文本里解析缺失目录并自愈。命中 --temp / --workspace 任一签名即处理。
 * 返回 {healed, results, signatures}；无签名时 healed=false 且 reason="no-signature"。
 */
export async function healFromError(text, opts = {}) {
  const raw = String(text || "");
  const tempDir = parseMissingTempDir(raw);
  const wsDir = parseMissingWorkspaceDir(raw);
  if (!tempDir && !wsDir) return { healed: false, reason: "no-signature", results: [] };
  const results = [];
  if (tempDir) results.push(await healTempDir(tempDir, opts));
  if (wsDir && wsDir !== tempDir) {
    let created = false;
    let ok = true;
    let error = "";
    try {
      if (!existsSync(wsDir)) {
        mkdirSync(wsDir, { recursive: true });
        created = true;
      }
    } catch (err) {
      ok = false;
      error = String(err.message || err);
    }
    results.push({ dir: wsDir, ok, created, grant: "skipped-workspace", error });
  }
  const signatures = [];
  if (tempDir) signatures.push("temp");
  if (wsDir) signatures.push("workspace");
  return { healed: results.some((r) => r.ok), results, signatures };
}

/** 一行人类可读摘要，给工具返回值用。 */
export function summarizeHeal(result) {
  if (!result || result.reason === "no-signature") return "未检测到 --temp/--workspace 缺失签名，未做处理。";
  const parts = result.results.map((r) => {
    const state = r.ok ? "已复活" : "失败";
    const extra = r.sid ? "（capability SID " + r.sid + "，" + r.grant + "，" + r.label + "）" : "";
    return state + " " + r.dir + extra + (r.error ? "：" + r.error : "");
  });
  return (result.healed ? "" : "未能全部修复：") + parts.join("；");
}
