// 统计 BYK 助手会话的真实 token 用量。
//
// 依据（来自 @deepseek-ai/dsh-session 文档与实测）：
//   - usage 在 `assistant/message` 事件的 `data.usage`：
//     { inputTokens, outputTokens, cacheReadTokens, reasoningTokens }
//   - 模型身份在 `data.message.source.{provider, model}`
//   - 会话目录名编码了 cwd；助手进程的 cwd 是 data/jobs/<turn>/<subtask>，
//     因此名字含 "data-jobs" 的目录即助手会话，可据此把开销精确归到某个回合/子任务。
//   - `web/deepseek-search-llm-request` 是 web_search 触发的独立服务端模型请求，
//     同样计费，单独统计。
//
// 用法：
//   node tools/usage_report.js <sessionsDir> [jobs|all] [--turn=t_xxx] [--json]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const root = positional[0];
const mode = positional[1] || 'jobs';
const turnFilter = flags.turn || null;
const asJson = Boolean(flags.json);

if (!root) {
  console.error('用法: node tools/usage_report.js <sessionsDir> [jobs|all] [--turn=t_xxx] [--json]');
  process.exit(2);
}

function findDirs(d, out = []) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) findDirs(p, out);
    else if (e.name === 'session.jsonl.zstd') out.push(path.dirname(p));
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 日志是「每行一个 zstd 帧」的拼接容器；流式解压器会在中途报错，所以手动切帧。
function decompressAll(buf) {
  const pos = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { pos.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < pos.length; k++) {
    // magic 也可能出现在压缩数据内部，失败就往后并一段重试
    for (let j = k + 1; j <= Math.min(k + 4, pos.length); j++) {
      const end = j < pos.length ? pos[j] : buf.length;
      try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos[k], end))); break; } catch (e) { /* 试下一段 */ }
    }
  }
  return Buffer.concat(parts);
}

let dirs = findDirs(root);
if (mode !== 'all') dirs = dirs.filter((d) => /data-jobs/.test(d.replace(/\\/g, '/')));
if (turnFilter) dirs = dirs.filter((d) => d.includes(turnFilter));

const byModel = {};
const byScope = {};
const totals = { steps: 0, input: 0, output: 0, cache: 0, reasoning: 0, search: 0 };
let sessions = 0;

for (const d of dirs) {
  let raw;
  try { raw = decompressAll(fs.readFileSync(path.join(d, 'session.jsonl.zstd'))).toString('utf8'); }
  catch (e) { continue; }
  sessions++;
  const m = d.replace(/\\/g, '/').match(/data-jobs-(.+)$/);
  const scope = m ? m[1].split('--')[0] : path.basename(d);
  byScope[scope] = byScope[scope] || { sessions: 0, steps: 0, input: 0, output: 0, cache: 0, search: 0 };
  byScope[scope].sessions++;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    if (o.type === 'web/deepseek-search-llm-request') { totals.search++; byScope[scope].search++; continue; }
    if (o.type !== 'assistant/message') continue;
    const u = (o.data && o.data.usage) || o.usage;
    if (!u) continue;
    const model = (o.data && o.data.message && o.data.message.source && o.data.message.source.model) || 'unknown';
    const inp = u.inputTokens || 0, out = u.outputTokens || 0;
    const cache = u.cacheReadTokens || 0, reas = u.reasoningTokens || 0;
    byModel[model] = byModel[model] || { steps: 0, input: 0, output: 0, cache: 0, reasoning: 0 };
    const b = byModel[model];
    b.steps++; b.input += inp; b.output += out; b.cache += cache; b.reasoning += reas;
    totals.steps++; totals.input += inp; totals.output += out; totals.cache += cache; totals.reasoning += reas;
    byScope[scope].steps++; byScope[scope].input += inp; byScope[scope].output += out; byScope[scope].cache += cache;
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({ sessions, totals, byModel, byScope }, null, 2));
  process.exit(0);
}

const fmt = (n) => n.toLocaleString('en-US');
console.log(`扫描会话: ${sessions} 个（模式=${mode}${turnFilter ? '，回合=' + turnFilter : ''}）`);
console.log(`模型步数: ${fmt(totals.steps)}；web_search 独立请求: ${fmt(totals.search)}\n`);

console.log('=== 按模型 ===');
console.log('模型'.padEnd(24) + '请求'.padStart(6) + '输入'.padStart(12) + '缓存命中'.padStart(12) + '输出'.padStart(10) + '推理'.padStart(10));
for (const [m, v] of Object.entries(byModel).sort((a, b) => b[1].output - a[1].output)) {
  console.log(m.padEnd(24) + fmt(v.steps).padStart(6) + fmt(v.input).padStart(12) + fmt(v.cache).padStart(12) + fmt(v.output).padStart(10) + fmt(v.reasoning).padStart(10));
}

console.log('\n=== 合计 ===');
console.log(`模型请求次数  : ${fmt(totals.steps)}`);
console.log(`输入 token    : ${fmt(totals.input)}`);
console.log(`缓存命中 token: ${fmt(totals.cache)}`);
console.log(`输出 token    : ${fmt(totals.output)}（其中推理 ${fmt(totals.reasoning)}）`);
console.log(`web_search 请求: ${fmt(totals.search)}（每次为独立服务端模型请求，单独计费）`);

console.log('\n=== 按回合/子任务（看钱花在哪） ===');
const rows = Object.entries(byScope).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
console.log('回合/子任务'.padEnd(30) + '会话'.padStart(5) + '请求'.padStart(6) + '输入'.padStart(12) + '输出'.padStart(10) + '检索'.padStart(6));
for (const [t, v] of rows) {
  console.log(t.slice(0, 29).padEnd(30) + String(v.sessions).padStart(5) + String(v.steps).padStart(6) + fmt(v.input).padStart(12) + fmt(v.output).padStart(10) + String(v.search).padStart(6));
}
