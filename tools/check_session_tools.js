// 检查某个会话最近的 request/header 里是否出现了指定工具名。
// 会话日志是「每行一个 zstd 帧」的拼接容器，需要手动切帧。
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const root = process.argv[2];
const sessionHint = process.argv[3];
const needles = process.argv.slice(4);

function findDirs(d, out = []) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) findDirs(p, out);
    else if (e.name === "session.jsonl.zstd") out.push(path.dirname(p));
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompressAll(buf) {
  const pos = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { pos.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < pos.length; k++) {
    for (let j = k + 1; j <= Math.min(k + 4, pos.length); j++) {
      const end = j < pos.length ? pos[j] : buf.length;
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos[k], end))); break; } catch { /* 试下一段 */ }
    }
  }
  return Buffer.concat(parts);
}

let dirs = findDirs(root);
if (sessionHint) dirs = dirs.filter((d) => d.includes(sessionHint));
// 取最近修改的
dirs.sort((a, b) => fs.statSync(path.join(b, "session.jsonl.zstd")).mtimeMs - fs.statSync(path.join(a, "session.jsonl.zstd")).mtimeMs);

console.log(`匹配会话数: ${dirs.length}`);
const file = path.join(dirs[0], "session.jsonl.zstd");
console.log(`检查: ${path.basename(dirs[0])}`);
console.log(`文件修改时间: ${fs.statSync(file).mtime.toISOString()}`);

const raw = decompressAll(fs.readFileSync(file)).toString("utf8");
let lastHeader = null;
let headerCount = 0;
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type === "request/header") { lastHeader = o; headerCount++; }
}
console.log(`request/header 事件数: ${headerCount}`);

if (!lastHeader) { console.log("没有 request/header"); process.exit(0); }
const tools = (lastHeader.data && lastHeader.data.header && lastHeader.data.header.tools) || [];
const names = tools.map((t) => t.name || t.function?.name).filter(Boolean);
console.log(`最近一次请求的工具数: ${names.length}`);
for (const n of needles) {
  console.log(`  ${names.includes(n) ? "✓ 存在" : "✗ 不存在"}  ${n}`);
}
console.log("\n全部工具名:");
console.log("  " + names.join(", "));
