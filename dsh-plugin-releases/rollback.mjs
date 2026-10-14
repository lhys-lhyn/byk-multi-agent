#!/usr/bin/env node
// rollback.mjs — 无 git 环境下的插件版本回退工具
//
// usage:
//   node rollback.mjs <snapshotDir> [--root <pluginDir>] [--backup-root <dir>]
//                                     [--manifest <file>] [--prune] [--dry-run]
//
// 行为:
//   1) 把 <pluginDir> 中除 node_modules 外的所有内容备份到 <backup-root>\pre-rollback-<timestamp>\
//   2) 用 <snapshotDir> 的内容覆盖回 <pluginDir>（node_modules 不动）
//      --prune 时额外删除 target 中「快照里没有」的文件（node_modules/.git 受保护，不删）
//   3) 逐文件 sha256 与 MANIFEST.json 比对，打印一致/不一致清单
//      --dry-run 不写盘: 逐行打印「要备份 / 要还原 / 要删除」的路径计划,
//      并把校验对象换成快照自身(快照完整 => 计划可执行)
//   退出码: 0 = 全部一致; 1 = 有不一致/缺失/损坏条目; 2 = 参数或清单结构错误
//
// MANIFEST.json 兼容形态(历史版本实际出现过三种, 见文件末尾「清单形态」注释):
//   A. files 是条目数组, 条目键 relPath|path  -> { bytes, sha256 }   v1.1.0-baseline / v1.2.0 / v1.4.2 / v1.5.x
//   B. files 是 { 文件名: "sha256字符串" } 映射                       v1.3.0 / v1.3.1
//   C. files 是 { 文件名: { sha256, size|bytes } } 映射               v1.4.0 / v1.4.1
//   sha256 大小写不敏感( v1.3.0 写的是大写十六进制 ).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROTECTED = ['node_modules', '.git'];
const SHA_RE = /^[0-9a-f]{64}$/i;

function parseArgs(argv) {
  const opts = { snapshot: null, root: 'C:\\Projects\\byk\\dsh-plugin', backupRoot: 'C:\\Projects\\byk\\dsh-plugin-releases', manifest: null, prune: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '--target') opts.root = argv[++i];
    else if (a === '--backup-root') opts.backupRoot = argv[++i];
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--prune') opts.prune = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else rest.push(a);
  }
  opts.snapshot = rest[0] ?? null;
  return opts;
}

/** 让人能读懂的值描述; 绝不因为值本身而抛异常. */
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  const t = typeof v;
  if (t === 'object') {
    const keys = Object.keys(v);
    return 'object{' + keys.slice(0, 6).join(',') + (keys.length > 6 ? ',...' : '') + '}';
  }
  if (t === 'string') {
    const s = v.length > 40 ? v.slice(0, 40) + '...' : v;
    return 'string(' + JSON.stringify(s) + ')';
  }
  return t + '(' + String(v) + ')';
}

/** 可读的致命错误: 只打印, 不抛 TypeError. */
function fail(message, code = 2) {
  console.error('ERROR: ' + message);
  process.exit(code);
}

/** 清单里的路径统一成正斜杠、去掉前导 ./ 与 /, 便于与 walk() 的结果比较. */
function normalizeRel(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function walk(dir, base = dir, out = [], top = true) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (top && PROTECTED.includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out, false);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- 参数与前置检查
const opts = parseArgs(process.argv.slice(2));
if (!opts.snapshot) {
  console.error('ERROR: missing <snapshotDir>. usage: node rollback.mjs <snapshotDir> [--root <pluginDir>]');
  process.exit(2);
}
const SNAP = path.resolve(opts.snapshot);
const ROOT = path.resolve(opts.root);
const MANIFEST = path.resolve(opts.manifest ?? path.join(SNAP, 'MANIFEST.json'));
if (!fs.existsSync(SNAP) || !fs.statSync(SNAP).isDirectory()) {
  fail('版本目录(SNAPSHOT)不存在或不是目录: ' + SNAP + '\n       用 --root 指定目标插件目录, 位置参数必须是存在的版本目录.');
}
if (!fs.existsSync(MANIFEST) || !fs.statSync(MANIFEST).isFile()) {
  fail('清单文件不存在: ' + MANIFEST + '\n       版本目录: ' + SNAP + '\n       可用 --manifest <file> 指定别的清单.');
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  fail('清单不是合法 JSON: ' + MANIFEST + '\n       版本目录: ' + SNAP + '\n       ' + (e && e.message ? e.message : String(e)));
}

// ---------------------------------------------------------------- 清单归一化
const entries = [];
const problems = [];

function addEntry(where, rawRel, rawSha, rawBytes) {
  if (typeof rawRel !== 'string' || rawRel.trim() === '') {
    problems.push({ where, reason: '条目缺少文件名: relPath / path 字段缺失或不是非空字符串 (实际 ' + describe(rawRel) + ')' });
    return;
  }
  const rel = normalizeRel(rawRel);
  if (rel === '') {
    problems.push({ where, reason: '条目文件名归一化后为空: ' + JSON.stringify(rawRel) });
    return;
  }
  let sha = null;
  if (typeof rawSha === 'string' && SHA_RE.test(rawSha.trim())) sha = rawSha.trim().toLowerCase();
  else if (rawSha === null || rawSha === undefined) problems.push({ where, reason: '条目缺少 sha256 字段, 该文件可还原但无法校验' });
  else problems.push({ where, reason: 'sha256 不是 64 位十六进制字符串 (实际 ' + describe(rawSha) + ')' });

  let bytes = null;
  if (typeof rawBytes === 'number' && Number.isFinite(rawBytes)) bytes = rawBytes;
  else if (rawBytes !== null && rawBytes !== undefined) problems.push({ where, reason: 'bytes/size 不是数字 (实际 ' + describe(rawBytes) + ')' });

  entries.push({ where, relPath: rel, sha256: sha, bytes });
}

const filesNode = Array.isArray(manifest)
  ? manifest
  : (manifest && typeof manifest === 'object' ? manifest.files : undefined);

if (filesNode === undefined || filesNode === null) {
  fail('清单缺少 files 字段: ' + MANIFEST
    + '\n       版本目录: ' + SNAP
    + '\n       顶层是 ' + describe(manifest) + ', 期望 { ..., files: [...] | { 文件名: sha256 } }');
}

if (Array.isArray(filesNode)) {
  filesNode.forEach((item, idx) => {
    const where = 'files[' + idx + ']';
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push({ where, reason: '条目不是对象 (实际 ' + describe(item) + ')' });
      return;
    }
    addEntry(where, item.relPath ?? item.path, item.sha256 ?? item.sha ?? item.hash, item.bytes ?? item.size);
  });
} else if (typeof filesNode === 'object') {
  for (const [name, value] of Object.entries(filesNode)) {
    const where = 'files[' + JSON.stringify(name) + ']';
    if (typeof value === 'string') addEntry(where, name, value, null);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) addEntry(where, name, value.sha256 ?? value.sha ?? value.hash, value.bytes ?? value.size);
    else problems.push({ where, reason: '映射值既不是 sha256 字符串也不是对象 (实际 ' + describe(value) + ')' });
  }
} else {
  fail('清单的 files 字段形态不支持: ' + MANIFEST
    + '\n       版本目录: ' + SNAP
    + '\n       实际是 ' + describe(filesNode) + '; 支持的形态: 条目数组 或 { 文件名: sha256字符串 | { sha256, bytes|size } }');
}

const seen = new Map();
for (const e of entries) {
  if (seen.has(e.relPath)) problems.push({ where: e.where, reason: '条目文件名重复: ' + e.relPath + ' (首次出现在 ' + seen.get(e.relPath) + ')' });
  else seen.set(e.relPath, e.where);
}

const meta = (!Array.isArray(manifest) && manifest && typeof manifest === 'object') ? manifest : null;
const metaName = meta ? [meta.name, meta.version].filter((x) => x !== undefined && x !== null && x !== '').join(' ') : '';

// ---------------------------------------------------------------- 计划头
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(path.resolve(opts.backupRoot), 'pre-rollback-' + stamp);

console.log('rollback ' + (opts.dryRun ? 'DRY-RUN (不写盘)' : 'APPLY'));
console.log('  snapshot : ' + SNAP);
console.log('  target   : ' + ROOT);
console.log('  manifest : ' + MANIFEST + (metaName ? '  [' + metaName + ']' : ''));
console.log('  entries  : ' + entries.length + (problems.length ? '  (' + problems.length + ' 条损坏)' : ''));
if (problems.length) {
  for (const p of problems) {
    console.log('  INVALID ENTRY  ' + p.where + ': ' + p.reason + '   [版本目录 ' + SNAP + ']');
  }
}

// ---------------------------------------------------------------- [1/3] 备份
console.log('[1/3] backup target -> ' + BACKUP);
const currentFiles = fs.existsSync(ROOT) ? walk(ROOT, ROOT, [], false) : [];
if (!fs.existsSync(ROOT)) {
  console.log('      target 目录不存在, 无需备份: ' + ROOT);
} else {
  for (const rel of currentFiles) console.log('      BACKUP    ' + path.join(ROOT, rel) + '  ->  ' + path.join(BACKUP, rel));
  if (opts.dryRun) {
    console.log('      (dry-run) would back up ' + currentFiles.length + ' file(s)');
  } else {
    for (const rel of currentFiles) {
      const to = path.join(BACKUP, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), to);
    }
    console.log('      backed up files: ' + currentFiles.length);
  }
}

// ---------------------------------------------------------------- [2/3] 还原
console.log('[2/3] overlay snapshot -> ' + ROOT);
const snapFiles = walk(SNAP, SNAP, [], false).filter((f) => f !== 'MANIFEST.json');
for (const rel of snapFiles) console.log('      RESTORE   ' + path.join(SNAP, rel) + '  ->  ' + path.join(ROOT, rel));
if (!opts.dryRun) {
  let copied = 0;
  for (const rel of snapFiles) {
    const to = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SNAP, rel), to);
    copied++;
  }
  console.log('      copied ' + copied + ' files');
} else {
  console.log('      (dry-run) would copy ' + snapFiles.length + ' files');
}

// 删除候选: target 里既不在清单、也不在快照中的文件(只对快照里没有的才算多余, 以免误删待还原文件)
const known = new Set([...entries.map((e) => e.relPath), ...snapFiles]);
const extras = currentFiles.filter((f) => !known.has(f));
if (extras.length) {
  console.log('      extra files in target not present in snapshot: ' + extras.length);
  for (const e of extras) console.log('      ' + (opts.prune ? 'DELETE    ' : 'KEEP      ') + path.join(ROOT, e));
  if (opts.prune) {
    if (opts.dryRun) console.log('      (dry-run) --prune would remove ' + extras.length + ' extra file(s)');
    else {
      let removed = 0;
      for (const rel of extras) {
        if (rel.split('/')[0] === '.git') continue;
        fs.rmSync(path.join(ROOT, rel), { force: true });
        removed++;
      }
      console.log('      --prune: removed ' + removed + ' extra file(s)');
    }
  } else {
    console.log('      (not removed; pass --prune to delete them)');
  }
}

// ---------------------------------------------------------------- [3/3] 校验
// APPLY 校验回滚后的 target; DRY-RUN 只校验快照自身(尚未写盘, 校验 target 必然全 MISSING)
const VERIFY_BASE = opts.dryRun ? SNAP : ROOT;
console.log('[3/3] verify sha256 against MANIFEST.json  (' + (opts.dryRun ? 'source snapshot' : 'target') + ': ' + VERIFY_BASE + ')');
let ok = 0;
const bad = [];
for (const e of entries) {
  const abs = path.join(VERIFY_BASE, e.relPath);
  if (!fs.existsSync(abs)) { bad.push({ rel: e.relPath, reason: 'MISSING' }); continue; }
  if (!e.sha256) { bad.push({ rel: e.relPath, reason: 'UNVERIFIED (清单条目没有可用的 sha256)' }); continue; }
  let got;
  try {
    got = sha256(abs);
  } catch (err) {
    bad.push({ rel: e.relPath, reason: 'READ ERROR: ' + (err && err.message ? err.message : String(err)) });
    continue;
  }
  if (got === e.sha256) { ok++; console.log('  OK       ' + e.relPath); }
  else { bad.push({ rel: e.relPath, reason: 'SHA256 mismatch', want: e.sha256, got }); }
}
for (const b of bad) {
  console.log('  MISMATCH ' + b.rel + '  ' + b.reason + (b.want ? '\n             want=' + b.want + '\n             got =' + b.got : ''));
}

// ---------------------------------------------------------------- 汇总
console.log('--- summary ---');
console.log('snapshot    : ' + SNAP);
console.log('target      : ' + ROOT);
console.log('manifest    : ' + MANIFEST);
console.log('verified    : ' + VERIFY_BASE);
console.log('consistent  : ' + ok + ' / ' + entries.length);
console.log('inconsistent: ' + bad.length + (problems.length ? ' (+ ' + problems.length + ' 条损坏清单条目)' : ''));
console.log('backup dir  : ' + (opts.dryRun ? '(dry-run, none)' : BACKUP));
process.exit(bad.length === 0 && problems.length === 0 ? 0 : 1);
