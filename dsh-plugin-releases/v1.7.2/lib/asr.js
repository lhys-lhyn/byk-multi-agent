/**
 * 直连小米 ASR：把音频文件交给 mimo-v2.5-asr 转写。
 *
 * 为什么绕开 DSH：pi-ai 的 xiaomi 目录只挂 6 个 chat 模型（mimo-v2.5 / v2.5-pro /
 * v2.6-flash / v2.6-pro 等），**没有 ASR/TTS 条目**；把 mimo-v2.5-asr 当 chat 模型
 * 走 DSH 只会拿到 400（ASR request requires a user message with input_audio content）。
 * 所以语音助手走这条直连：插件直接按 ASR 的报文格式请求，再把转写交回给模型整理。
 *
 * 实测报文（2026-10-01）：
 *   POST {base}/chat/completions
 *   { model: "mimo-v2.5-asr",
 *     messages: [{ role: "user", content: [{ type: "input_audio",
 *                  input_audio: { data: "<base64 或 data:...;base64,...>", format: "wav" } }] }] }
 *   -> 200 { choices[0].message.content: "转写文本" }
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { errorChainText, networkHint } from "./jev.js";

/** 小米 OpenAI 兼容端点。 */
export const DEFAULT_ASR_BASE_URL = "https://api.xiaomimimo.com/v1";
/** 小米 ASR 模型 id。 */
export const DEFAULT_ASR_MODEL = "mimo-v2.5-asr";
/** 单次请求的音频上限（base64 会再膨胀约 4/3）。 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** 认得的音频后缀 -> 小米要的 format 字段。 */
const FORMAT_BY_EXT = {
  ".wav": "wav", ".mp3": "mp3", ".m4a": "m4a", ".aac": "aac",
  ".flac": "flac", ".ogg": "ogg", ".opus": "opus", ".wma": "wma", ".amr": "amr",
};

/**
 * 从凭据文件（DSH 的 .credentials.yaml）或环境变量里取 apiKey。
 * @param envName 凭据名，默认 XIAOMI_API_KEY
 * @param dshHome DSH home，默认取 process.env.DSH_HOME，再退回 C:\coding\DSH Home
 * @returns apiKey，取不到返回空串
 */
export function resolveApiKey(envName = "XIAOMI_API_KEY", dshHome = "") {
  const env = (globalThis.process && globalThis.process.env) || {};
  if (env[envName]) return env[envName];
  const home = String(dshHome || env.DSH_HOME || "C:\\coding\\DSH Home").replace(/[\\/]+$/, "");
  try {
    const text = readFileSync(home + "\\.credentials.yaml", "utf8");
    const m = text.match(new RegExp("^\\s*" + envName + "\\s*:\\s*(\\S+)", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/**
 * 从一段任务文本里找出音频文件路径。
 * 认绝对路径（C:\... / \\server\... / /...）且后缀是音频格式。
 * @returns 路径或空串
 */
export function findAudioPath(text) {
  const src = String(text || "");
  const re = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'，。；、)）\]】》]+/g;
  const hits = src.match(re) || [];
  for (const raw of hits) {
    const cleaned = raw.replace(/[.,;:]+$/, "");
    const ext = extname(cleaned).toLowerCase();
    if (FORMAT_BY_EXT[ext]) return cleaned;
  }
  return "";
}

/**
 * 直连小米 ASR 转写一个音频文件。
 * @param options.filePath 音频绝对路径
 * @param options.apiKey 缺省时用 resolveApiKey
 * @param options.model 默认 mimo-v2.5-asr
 * @param options.baseURL 默认官方端点
 * @returns { ok, text, error, model, bytes, ms }
 */
export async function transcribeAudio(options = {}) {
  const started = Date.now();
  const filePath = String(options.filePath || "");
  const model = options.model || DEFAULT_ASR_MODEL;
  const baseURL = String(options.baseURL || DEFAULT_ASR_BASE_URL).replace(/\/+$/, "");
  if (!filePath) return { ok: false, text: "", error: "没有给出音频文件路径", model, bytes: 0, ms: 0 };

  const ext = extname(filePath).toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) return { ok: false, text: "", error: "不认的音频后缀：" + (ext || "（无）"), model, bytes: 0, ms: 0 };

  let buf;
  try {
    buf = readFileSync(filePath);
  } catch (err) {
    return { ok: false, text: "", error: "读不到音频文件：" + String(err && err.message), model, bytes: 0, ms: 0 };
  }
  if (buf.length === 0) return { ok: false, text: "", error: "音频文件是空的", model, bytes: 0, ms: 0 };
  if (buf.length > MAX_AUDIO_BYTES) {
    return { ok: false, text: "", error: "音频超过 " + Math.round(MAX_AUDIO_BYTES / 1048576) + "MB 上限", model, bytes: buf.length, ms: 0 };
  }

  const apiKey = options.apiKey || resolveApiKey(options.apiKeyEnv || "XIAOMI_API_KEY", options.dshHome);
  if (!apiKey) return { ok: false, text: "", error: "拿不到 apiKey（环境变量或 .credentials.yaml 里都没有）", model, bytes: buf.length, ms: 0 };

  const body = {
    model,
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: "data:audio/" + format + ";base64," + buf.toString("base64"), format } }],
    }],
  };

  try {
    const res = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 走下面报错 */ }
    const ms = Date.now() - started;
    if (!res.ok) {
      const detail = parsed && parsed.error ? JSON.stringify(parsed.error) : text.slice(0, 300);
      return { ok: false, text: "", error: "ASR HTTP " + res.status + "：" + detail, model, bytes: buf.length, ms };
    }
    const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? String(parsed.choices[0].message.content || "").trim()
      : "";
    return { ok: !!content, text: content, error: content ? "" : "转写结果为空", model, bytes: buf.length, ms };
  } catch (err) {
    const chain = errorChainText(err);
    return { ok: false, text: "", error: "请求失败：" + chain + networkHint(chain), model, bytes: buf.length, ms: Date.now() - started };
  }
}
