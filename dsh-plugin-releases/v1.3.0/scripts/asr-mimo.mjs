#!/usr/bin/env node
/**
 * 直连小米 ASR 的命令行脚本（语音助手内部也会调用同一份 lib/asr.js）。
 *
 * 用法：
 *   node scripts/asr-mimo.mjs <音频文件> [--json] [--model mimo-v2.5-asr]
 *        [--base-url https://api.xiaomimimo.com/v1] [--key-env XIAOMI_API_KEY] [--dsh-home "C:\coding\DSH Home"]
 *
 * 例：
 *   node scripts/asr-mimo.mjs "C:\path\speech.wav"
 *   node scripts/asr-mimo.mjs "C:\path\speech.mp3" --json
 */
import { transcribeAudio, resolveApiKey } from "../lib/asr.js";

const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (key === "json") { opts.json = true; continue; }
    opts[key] = argv[++i];
  } else positional.push(a);
}

if (positional.length === 0) {
  console.error("用法：node scripts/asr-mimo.mjs <音频文件> [--json] [--model ...] [--base-url ...] [--key-env ...] [--dsh-home ...]");
  process.exit(2);
}

const result = await transcribeAudio({
  filePath: positional[0],
  model: opts.model,
  baseURL: opts["base-url"],
  apiKeyEnv: opts["key-env"],
  dshHome: opts["dsh-home"],
  apiKey: opts.key,
});

if (opts.json) {
  console.log(JSON.stringify(result));
} else if (result.ok) {
  console.log(result.text);
} else {
  console.error("转写失败：" + result.error);
}

// 顺带把 key 是否存在打给 stderr，方便排查（不打内容）
if (!result.ok && !resolveApiKey(opts["key-env"] || "XIAOMI_API_KEY", opts["dsh-home"] || "")) {
  console.error("提示：XIAOMI_API_KEY 既不在环境变量，也不在 .credentials.yaml 里");
}
process.exit(result.ok ? 0 : 1);
