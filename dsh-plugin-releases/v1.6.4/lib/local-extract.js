/**
 * BYK 本地提取层（byk.extract）的插件侧适配：扩展名判定、任务文本里的路径抽取、
 * byk.cli extract 的输出解析、以及结果/错误文案的格式化。
 *
 * 定位：backend = "local-extract" 的角色**不拉云端子智能体**，只把任务里给出的文件交给
 * BYK 自带的本地提取层变成「文本 + 元数据」。全程本地推理（pypdf / python-docx /
 * python-pptx / openpyxl / rapidocr-onnxruntime / faster-whisper），不调用任何 LLM、
 * 不需要 API key、不需要网络。
 *
 * 契约：
 *   - 本文件的导出**全是纯函数**：吃普通对象、吐普通对象或字符串，不碰文件系统、不跑进程。
 *     设置页与单测（test/routing-local.test.js）直接复用。
 *   - 真正 spawn 的动作只在 lib/index.js 的 local-extract 分支里发生。
 *   - **禁止静默回落云端**：任何「缺东西 / 不确定」都以明确失败返回，绝不改走 LLM。
 *   - 扩展名表与 byk/extract/dispatch.py 的 _DOCUMENT_EXTS / _IMAGE_EXTS / _AUDIO_EXTS /
 *     _VIDEO_EXTS / _ARCHIVE_EXTS / _TEXT_EXTS 保持一致（两边当前都是 v1.0.0）。
 */

/** 这个后端的标识：roles.<id>.backend 的取值之一。 */
export const EXTRACT_BACKEND = "local-extract";

/** 提取层认得的所有类型（与 byk.extract.ALL_KINDS 同一个集合）。 */
export const EXTRACT_KINDS = ["document", "image", "audio", "video", "archive", "text", "unknown"];

/** 扩展名 -> 类型。一次判定，别再散落第二份表。 */
const EXTENSION_KIND = {
  ".pdf": "document", ".docx": "document", ".pptx": "document", ".xlsx": "document",
  ".xlsm": "document", ".rtf": "document",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".bmp": "image", ".gif": "image",
  ".webp": "image", ".tif": "image", ".tiff": "image", ".ico": "image", ".jfif": "image",
  ".heic": "image",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio",
  ".ogg": "audio", ".oga": "audio", ".opus": "audio", ".wma": "audio", ".amr": "audio",
  ".aiff": "audio", ".aif": "audio", ".ape": "audio", ".mka": "audio",
  ".mp4": "video", ".mov": "video", ".avi": "video", ".mkv": "video", ".webm": "video",
  ".flv": "video", ".wmv": "video", ".m4v": "video", ".mpg": "video", ".mpeg": "video",
  ".ts": "video", ".m2ts": "video", ".3gp": "video", ".rmvb": "video", ".vob": "video",
  ".zip": "archive",
  ".txt": "text", ".md": "text", ".markdown": "text", ".rst": "text", ".csv": "text",
  ".tsv": "text", ".json": "text", ".jsonl": "text", ".ndjson": "text", ".log": "text",
  ".yaml": "text", ".yml": "text", ".xml": "text", ".toml": "text", ".ini": "text",
  ".cfg": "text", ".conf": "text", ".srt": "text", ".vtt": "text",
};

/** 可处理的扩展名（排序后，与 byk.extract.SUPPORTED_EXTENSIONS 逐项相同）。 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_KIND).sort();

/** 扩展名列表的中文顿号串，报错文案里直接拼。 */
export const SUPPORTED_EXTENSIONS_TEXT = SUPPORTED_EXTENSIONS.join("、");

/** 每个类型走的本地推理路径，用来说清「这次到底用了什么」。 */
const KIND_LABEL = {
  document: "文档解析",
  image: "图片 OCR",
  audio: "语音转写",
  video: "视频抽帧 + 语音转写",
  archive: "压缩包列举",
  text: "纯文本直读",
  unknown: "未识别类型",
};

/** 每个类型缺库时该装什么。空串 = 纯标准库，装不了也修不了。 */
const KIND_PACKAGES = {
  document: "pypdf python-docx python-pptx openpyxl",
  image: "rapidocr-onnxruntime",
  audio: "faster-whisper",
  video: "faster-whisper rapidocr-onnxruntime",
  archive: "",
  text: "",
  unknown: "",
};

/** byk.extract 的 method 字段 -> 真正干活的库（模型标识与文案都用它）。 */
const METHOD_LIBRARY = {
  pypdf: "pypdf",
  "python-pptx": "python-pptx",
  "python-docx": "python-docx",
  openpyxl: "openpyxl",
  zipfile: "zipfile",
  passthrough: "passthrough",
};

/** 路径候选：盘符绝对路径（C:\ 或 C:/）与 UNC（\\server\share\...）。 */
const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\\\\\)[^\s"'\u3000,;()\[\]{}<>|\u2010-\u2027\u3000-\u303f\uff01-\uff65]+/g;

/** 路径尾巴上常见的标点：句号、顿号、右括号之类，抽出来要去掉。 */
const TRAILING_RE = /[.,;:!?、。，；：）)】\]]+$/;

/** 全角标点、全角空格、破折号、省略号、中文引号：中文里紧跟在路径后面的常见字符。 */
const FULLWIDTH_RE = /[\u2010-\u2027\u3000-\u303f\uff01-\uff65]/;

/**
 * 路径尾巴上粘了全角标点或汉字时往回截断（正则很难一刀切干净）。
 * 「D:/a/b.pdf，还有」-> 「D:/a/b.pdf」；「C:/a/b.pdf然后」-> 「C:/a/b.pdf」。
 * 只有在后面确实跟着汉字时才按扩展名边界截断，避免把 report.pdf.bak 误当成 report.pdf。
 */
function trimPathTail(candidate) {
  const str = String(candidate || "");
  const cut = str.search(FULLWIDTH_RE);
  if (cut > 0) return str.slice(0, cut);
  const lower = str.toLowerCase();
  let bestLen = 0;
  for (const ext of SUPPORTED_EXTENSIONS) {
    const idx = lower.indexOf(ext);
    if (idx >= 0 && idx + ext.length > bestLen) bestLen = idx + ext.length;
  }
  const tail = str.slice(bestLen);
  if (bestLen > 0 && bestLen < str.length && /[\u4e00-\u9fff]/.test(tail)) return str.slice(0, bestLen);
  return str;
}

/** 取路径的最后一段（文件名）。Windows 与 POSIX 两种分隔符都认。 */
const NAME_RE = /(?:^|[\\/])([^\\/]*)$/;

/** 覆盖层认得的 backend 列表（设置页写回时用它做下拉框）。 */
export const BACKEND_CHOICES = ["llm", "asr", "local", "local-extract"];

/** 失败文案里固定要出现的一句：说清「本地不可用也不换云端」。 */
export const NO_FALLBACK_NOTE =
  "本地提取层不可用时**不会**自动改用云端模型：要么按上面的提示修好本地环境，" +
  "要么把该角色的 backend 显式改回 llm。";

/** byk.cli 的 extract 子命令补丁文件（缺子命令时把路径直接告诉用户）。 */
export const EXTRACT_CLI_PATCH_FILE = "C:/Projects/dsh/.byk-164/s4/py/cli-extract.patch.md";

/** 路径的最后一段；没有分隔符时就是原串。 */
export function baseNameOf(filePath) {
  const m = NAME_RE.exec(String(filePath || ""));
  return (m && m[1]) || String(filePath || "");
}

/** 小写扩展名（含点）；没有扩展名或只有隐藏文件前缀时返回空串。 */
export function extensionOf(filePath) {
  const name = baseNameOf(filePath);
  const i = name.lastIndexOf(".");
  if (i <= 0) return "";
  return name.slice(i).toLowerCase();
}

/**
 * 扩展名 -> 类型，规则与 byk.extract.detect_kind 一致：未知或无扩展名一律 "unknown"。
 * @param filePath 文件路径（Windows / POSIX 都行）。
 * @returns EXTRACT_KINDS 之一。
 */
export function detectExtractKind(filePath) {
  return EXTENSION_KIND[extensionOf(filePath)] || "unknown";
}

/** 这个类型走的是哪种本地推理，给用户看的一行字。 */
export function describeLocalMethod(kind, method) {
  const lib = libraryOf(method);
  const label = KIND_LABEL[kind] || KIND_LABEL.unknown;
  return "本地提取层 " + (lib || "byk.extract") + "（" + label + "）";
}

/** method 字段归一成库名：whisper:* -> faster-whisper，ocr:* -> rapidocr-onnxruntime。 */
export function libraryOf(method) {
  const m = String(method || "").trim();
  if (!m) return "";
  if (m.startsWith("whisper")) return "faster-whisper";
  if (m.startsWith("ocr:")) return "rapidocr-onnxruntime";
  return METHOD_LIBRARY[m] || m;
}

/**
 * route.model 用的本地标识：一个库 -> "local:rapidocr-onnxruntime"；多个 ->
 * "local:extract(pypdf+faster-whisper)"；没有成功项 -> "local:extract"。
 * @param methods byk.extract 返回的 method 字段数组。
 */
export function localModelLabel(methods) {
  const libs = [...new Set((methods || []).map(libraryOf).filter(Boolean))].sort();
  if (libs.length === 0) return "local:extract";
  if (libs.length === 1) return "local:" + libs[0];
  return "local:extract(" + libs.join("+") + ")";
}

/**
 * 从任务文本里抽绝对路径。**纯函数**：只按形状匹配，不碰文件系统。
 * 扩展名不在支持表里的候选不会被丢掉，进 rejected —— 报错文案要说清「为什么没算它」。
 * @param text 任务说明原文。
 * @returns {paths[], rejected[]}，两个数组都保持出现顺序且去重（大小写不敏感）。
 */
export function findExtractPaths(text) {
  const s = String(text || "");
  const seen = new Set();
  const paths = [];
  const rejected = [];
  const matches = s.match(PATH_RE) || [];
  for (const rawMatch of matches) {
    const cleaned = trimPathTail(rawMatch.replace(TRAILING_RE, ""));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (detectExtractKind(cleaned) === "unknown") rejected.push(cleaned);
    else paths.push(cleaned);
  }
  return { paths, rejected };
}

/** 缺库时该跑的那条命令；这个类型是纯标准库时返回空串。 */
export function installHint(kind, pythonPath) {
  const pkgs = KIND_PACKAGES[kind] || "";
  if (!pkgs) return "";
  return String(pythonPath || "python") + " -m pip install " + pkgs;
}

/**
 * 判断 python 的报错是不是「根本没有 extract 这个子命令」。
 * argparse 对未知子命令会说 invalid choice，实测文案：invalid choice: ... (choose from ...)。
 */
export function looksLikeMissingSubcommand(stderr) {
  const s = String(stderr || "");
  return /invalid choice/i.test(s) && /extract/.test(s);
}

/**
 * 解析 byk.cli extract --json 的 stdout。**纯函数**（只解析字符串）。
 * python 侧可能先打日志再打 JSON，所以取**最外层**大括号那一段再 parse。
 * @returns {ok:true, payload} 或 {ok:false, reason, error}
 *   reason: "empty-output" | "not-json" | "no-results"
 */
export function parseExtractOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, reason: "empty-output", error: "" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    let payload = null;
    try { payload = JSON.parse(text.slice(start, end + 1)); } catch { payload = null; }
    if (payload && Array.isArray(payload.results)) return { ok: true, payload };
  }
  return { ok: false, reason: "not-json", error: text.slice(0, 800) };
}

/**
 * 提取结果 -> 给模型看的正文 + 这次实际的本地标识。
 * 每个文件都打印「真实走的本地路径」；只要有文件失败，ok 就是 false（不掩盖部分失败）。
 * @param payload byk.cli extract --json 的载荷 {results:[{path,name,kind,ok,text,meta,error,method}]}。
 * @param opts 可选 {python, commandLine}。
 * @returns {ok, model, text}
 */
export function formatExtractReport(payload, opts) {
  const o = opts || {};
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  const okCount = results.filter((r) => r && r.ok).length;
  const model = localModelLabel(results.filter((r) => r && r.ok).map((r) => r && r.method));
  const lines = [];
  lines.push("【本地提取层 · " + results.length + " 个文件 · " + okCount + " 成功 / " +
    (results.length - okCount) + " 失败】");
  if (o.commandLine) lines.push("命令：" + o.commandLine);
  results.forEach((entry, i) => {
    const r = entry || {};
    const kind = r.kind || "unknown";
    lines.push("");
    lines.push("── [" + (i + 1) + "/" + results.length + "] " + (r.ok ? "成功" : "失败") + " " +
      (r.path || r.name || "(未知路径)"));
    if (r.ok) {
      lines.push("类型：" + kind + " ｜ 本地路径：" + describeLocalMethod(kind, r.method));
      if (r.meta && r.meta.truncated) lines.push("注意：正文超过 200 KB 上限，已截断。");
      lines.push("");
      lines.push(String(r.text || "").trim() || "（提取成功，但没有文本内容）");
    } else {
      lines.push("类型：" + kind + " ｜ 本地路径：" + describeLocalMethod(kind, r.method));
      lines.push("失败：" + String(r.error || "（本地提取层没给出原因）"));
      const hint = installHint(kind, o.python);
      if (hint) lines.push("装法：" + hint);
    }
  });
  lines.push("");
  lines.push("（以上全部由本地推理完成，未调用任何云端模型。）");
  return { ok: results.length > 0 && okCount === results.length, model, text: lines.join("\n") };
}

/**
 * 失败文案的唯一出口：每种失败都要点名「缺什么 / 装什么 / 支持哪些扩展名」，
 * 并且**逐字**带上 NO_FALLBACK_NOTE。
 * @param info {reason, detail, stderr, code, paths[], rejected[], python, commandLine}
 *   reason: "no-path" | "path-unsupported" | "missing-cli" | "spawn-failed" |
 *           "empty-output" | "not-json" | "exit"
 * @returns 可直接写进工具结果正文的字符串。
 */
export function localExtractFailureText(info) {
  const i = info || {};
  const py = i.python || "python";
  const head = "【本地提取层】本次提取没有成功，也没有改用云端模型。";
  const tail = ["", "支持的文件类型（" + SUPPORTED_EXTENSIONS.length + " 个扩展名）：" +
    SUPPORTED_EXTENSIONS_TEXT, "本地提取层的 python：" + py, NO_FALLBACK_NOTE];
  const lines = [head];
  switch (i.reason) {
    case "no-path":
      lines.push("原因：任务里没有找到任何文件路径。本地提取层需要**绝对路径**，请把路径直接写进任务说明。");
      break;
    case "path-unsupported":
      lines.push("原因：找到的路径扩展名都不在支持表里，提取层处理不了。");
      lines.push("这些路径没被接受：" + (i.rejected || []).join("、"));
      break;
    case "missing-cli":
      lines.push("原因：BYK 的 cli.py 里还没有 extract 子命令（python -m byk.cli extract），本地提取层调不起来。");
      lines.push("修法：给 " + "byk/cli.py 加上 extract 子命令，补丁文件：" + EXTRACT_CLI_PATCH_FILE +
        "（加完不需要重建插件、不需要重启 DSH）。");
      break;
    case "spawn-failed":
      lines.push("原因：本地提取层的进程起不来（python 路径可能不对）。");
      lines.push("命令：" + (i.commandLine || "(未记录)"));
      break;
    case "empty-output":
      lines.push("原因：python 跑完了但没有任何输出，无法判断提取结果。");
      break;
    case "not-json":
      lines.push("原因：python 的输出不是预期的 JSON，无法解析提取结果。");
      break;
    default:
      lines.push("原因：python 退出码 " + (i.code === undefined ? "未知" : i.code) + "，提取命令没跑成功。");
      break;
  }
  if (i.detail) lines.push("原始信息：" + String(i.detail).slice(0, 1500));
  if (i.stderr) lines.push("stderr：" + String(i.stderr).trim().slice(0, 1500));
  return lines.concat(tail).join("\n");
}
