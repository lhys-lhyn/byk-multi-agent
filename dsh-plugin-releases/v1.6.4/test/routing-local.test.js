/**
 * 逐助手模型配置 + 本地提取层（backend: "local-extract"）单元测试。
 * 运行：node test/routing-local.test.js
 *
 * 这个文件**全是纯函数**：不起子进程、不碰文件系统、不访问网络。
 * 本地提取层真正跑 python 的那一段在 lib/index.js 的 runRoleBody 里，
 * 需要真解释器的冒烟测试放在 test/run-smoke.mjs。
 */
import assert from "node:assert/strict";
import {
  BACKENDS,
  DEFAULT_ROLES,
  describeEffectiveRoute,
  formatRoute,
  resolveConfig,
  resolveLocalExtractCommand,
  resolveRoute,
} from "../lib/routing.js";
import {
  BACKEND_CHOICES,
  EXTRACT_CLI_PATCH_FILE,
  NO_FALLBACK_NOTE,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_EXTENSIONS_TEXT,
  baseNameOf,
  describeLocalMethod,
  detectExtractKind,
  extensionOf,
  findExtractPaths,
  formatExtractReport,
  installHint,
  localExtractFailureText,
  localModelLabel,
  looksLikeMissingSubcommand,
  parseExtractOutput,
} from "../lib/local-extract.js";

/** 北京时间的某个时刻 -> 秒。与 test/timing.test.js 保持一致。 */
function bj(y, m, d, hh, mm = 0) {
  return Date.UTC(y, m - 1, d, hh - 8, mm, 0) / 1000;
}
const peakSec = bj(2026, 10, 9, 10, 0);
const valleySec = bj(2026, 10, 9, 20, 0);

const step = (t) => console.log("  ✓ " + t);

// ───────────────────────────────────────────────────────────────────────────
console.log("【1】backend 取值域与选择");
assert.deepEqual(BACKENDS, ["llm", "asr", "local", "local-extract"]);
// 设置页的下拉框与路由层必须是同一份定义，否则会写出路由层不认的值。
assert.deepEqual(BACKEND_CHOICES, BACKENDS);

assert.equal(resolveRoute("code", { now: peakSec }).backend, "llm");
assert.equal(resolveRoute("audio", { now: peakSec }).backend, "asr");
assert.equal(resolveRoute("file", { now: peakSec }).backend, "llm");

const cfgLocal = { roles: { file: { backend: "local" } }, local: { enabled: true, command: "echo", args: [] } };
assert.equal(resolveRoute("file", { now: peakSec, config: cfgLocal }).backend, "local");

const overlayLE = { version: 1, roles: { vision: { backend: "local-extract" } } };
const leRoute = resolveRoute("vision", { now: peakSec, overlay: overlayLE });
assert.equal(leRoute.backend, "local-extract");
assert.equal(leRoute.provider, "local");
assert.equal(leRoute.model, "local:extract");
assert.equal(leRoute.reasoningEffort, undefined);
assert.equal(leRoute.sourceKind, "local-extract");
assert.equal(leRoute.phase, null);
assert.equal(formatRoute(leRoute), "本地提取层 byk.extract（不调用任何 LLM）");
step("llm / asr / local / local-extract 四种 backend 都能选出来");

// 写错就报错，绝不静默落到 llm
assert.throws(() => resolveRoute("file", { config: { roles: { file: { backend: "ollama" } } } }), /未知 backend/);
assert.throws(() => resolveRoute("file", { overlay: { roles: { file: { backend: "local_ex" } } } }), /未知 backend/);
step("未知 backend 立刻报错，不回落 llm");

for (const b of BACKENDS) {
  const r = resolveRoute("file", { now: peakSec, config: { roles: { file: { backend: b } } } });
  assert.equal(r.backend, b, b);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("【2】优先级：逐助手显式配置 > 峰谷 > DEFAULT_ROLES 基准");

// ① 覆盖层显式写了 provider+model —— 压过高/低谷
const overlayOv = { version: 1, roles: { task: { provider: "deepseek-official", model: "deepseek-v4-flash" } } };
const r1 = resolveRoute("task", { now: peakSec, overlay: overlayOv });
assert.equal(r1.provider, "deepseek-official");
assert.equal(r1.model, "deepseek-v4-flash");
assert.equal(r1.source, "overlay");
assert.equal(r1.sourceKind, "role-override");
assert.equal(r1.phase, null, "被覆盖时峰谷不再参与，phase 必须为空");
assert.equal(r1.routed, false);
assert.equal(r1.nextChange, null);
step("覆盖层压过峰谷：" + formatRoute(r1));

// ② agents.config.json 的 roles.<id> 显式写过，也算覆盖（在峰谷之上、覆盖层之下）
const cfgModel = { roles: { task: { model: "deepseek-v4-flash" } } };
const r2 = resolveRoute("task", { now: peakSec, config: cfgModel });
assert.equal(r2.model, "deepseek-v4-flash");
assert.equal(r2.source, "role");
assert.equal(r2.sourceKind, "role-override");
assert.equal(r2.provider, "xiaomi", "只写了 model 时 provider 沿用下一层（高峰值）");
step("config 的 roles.task.model 也压过峰谷，provider 沿用下一层");

// ③ 覆盖层压过 config 的同名字段
const r3 = resolveRoute("task", { now: peakSec, config: cfgModel, overlay: { roles: { task: { model: "mimo-v2.6-flash" } } } });
assert.equal(r3.source, "overlay");
assert.equal(r3.model, "mimo-v2.6-flash");
step("覆盖层 > agents.config.json");

// ④ reasoningEffort 也能逐助手覆盖（低谷默认 high）
const r4 = resolveRoute("code", { now: valleySec, config: { roles: { code: { reasoningEffort: "medium" } } } });
assert.equal(r4.reasoningEffort, "medium");
assert.equal(r4.sourceKind, "role-override");
assert.match(formatRoute(r4), /effort=medium/);
step("reasoningEffort 可被逐助手覆盖");

// ⑤ 显式写了与默认值相同的值，仍然算覆盖（看的是「写过没有」，不是「值变没变」）
const r5 = resolveRoute("vision", { config: { roles: { vision: { model: "mimo-v2.6-flash" } } } });
assert.equal(r5.sourceKind, "role-override");
assert.equal(r5.source, "role");
step("写回与出厂值相同的模型也算显式配置");

// ⑥ 空串不算覆盖（等同于没写）
const r6 = resolveRoute("task", { now: peakSec, overlay: { roles: { task: { model: "" } } } });
assert.equal(r6.source, "routing.peak");
assert.equal(r6.sourceKind, "peak");
assert.equal(r6.model, "mimo-v2.6-flash");
const r6b = resolveRoute("task", { now: peakSec, config: { roles: { task: { model: "" } } } });
assert.equal(r6b.source, "routing.peak", "config 里的空串也要等同于没写");
step("空串等同于没写，沿用下一层");

// ⑦ 未配置时逐字段不变：整体深比较
const bare = resolveRoute("task", { now: peakSec });
const withEmptyOverlay = resolveRoute("task", { now: peakSec, overlay: { version: 1, roles: {} } });
assert.deepEqual(withEmptyOverlay, bare);
for (const id of Object.keys(DEFAULT_ROLES)) {
  assert.deepEqual(
    resolveRoute(id, { now: peakSec, overlay: { version: 1, roles: {} } }),
    resolveRoute(id, { now: peakSec }),
    id,
  );
}
step("空覆盖层下 7 个角色逐字段完全等价");

// ⑧ 与既有 test/timing.test.js 逐字一致的回归护栏
const p = resolveRoute("task", { now: peakSec });
assert.equal(p.provider, "xiaomi");
assert.equal(p.model, "mimo-v2.6-flash");
assert.equal(p.reasoningEffort, undefined);
assert.equal(p.phase, "peak");
assert.equal(p.source, "routing.peak");
assert.equal(p.sourceKind, "peak");
assert.equal(formatRoute(p), "xiaomi/mimo-v2.6-flash ｜高峰");

const v = resolveRoute("task", { now: valleySec });
assert.equal(v.provider, "deepseek-official");
assert.equal(v.model, "deepseek-flash");
assert.equal(v.reasoningEffort, "high");
assert.equal(v.sourceKind, "off-peak");
assert.equal(formatRoute(v), "deepseek-official/deepseek-flash effort=high ｜低谷");

const vis = resolveRoute("vision", { now: peakSec });
assert.equal(vis.source, "role");
assert.equal(vis.sourceKind, "default");
assert.equal(vis.phase, null);
assert.equal(vis.model, "mimo-v2.6-flash");
assert.equal(formatRoute(vis), "xiaomi/mimo-v2.6-flash ｜固定路由");

const aud = resolveRoute("audio", { now: peakSec });
assert.equal(aud.backend, "asr");
assert.equal(aud.model, "mimo-v2.5-asr");
assert.equal(formatRoute(aud), "直连 ASR mimo-v2.5-asr → mimo-v2.6-flash");

assert.equal(resolveRoute("research", { now: peakSec }).model, "mimo-v2.6-pro");
step("老行为逐字段不变（peak / off-peak / registry / asr / research 白名单）");

// ⑨ forbiddenModels 硬拦仍然优先于一切覆盖
assert.throws(
  () => resolveRoute("vision", { config: { roles: { vision: { model: "mimo-v2.6-pro-ultraspeed" } } } }),
  /forbidden model/,
);
assert.throws(
  () => resolveRoute("task", { now: peakSec, overlay: { roles: { task: { model: "deepseek-v4-pro" } } } }),
  /forbidden model/,
);
step("禁用模型名单仍然硬拦（覆盖层也越不过）");

// ───────────────────────────────────────────────────────────────────────────
console.log("【3】覆盖层新增的角色");
const registry = { writer: { name: "写作助手", provider: "deepseek-official", model: "deepseek-flash" } };
const wr = resolveRoute("writer", {
  now: peakSec,
  registry,
  overlay: { version: 1, roles: { writer: { model: "deepseek-v4-flash" } } },
});
assert.equal(wr.model, "deepseek-v4-flash");
assert.equal(wr.source, "overlay");
assert.equal(wr.roleId, "writer");
assert.throws(() => resolveRoute("writer", { registry: { writer: { name: "x" } } }), /unknown role/);
assert.throws(() => resolveRoute("nobody", {}), /unknown role/);
step("覆盖层新增角色能解析出路由；兜不出来时报错文案不变");

// ───────────────────────────────────────────────────────────────────────────
console.log("【4】local-extract 的命令构造");
const cfgLE = { roles: { file: { backend: "local-extract" } } };
const spec = resolveLocalExtractCommand("file", {
  config: cfgLE, python: "C:/py/python.exe", pathsFile: "C:/tmp/paths.txt",
});
assert.equal(spec.command, "C:/py/python.exe");
assert.deepEqual(spec.args, [
  "-m", "byk.cli", "extract", "--json", "--paths-file", "C:/tmp/paths.txt",
  "--whisper-model", "small", "--ocr-lang", "ch",
]);
assert.equal(spec.pathsFile, "C:/tmp/paths.txt");
step("默认命令：" + spec.command + " " + spec.args.join(" "));

const spec2 = resolveLocalExtractCommand("file", {
  config: { localExtract: { command: "C:/py/python.exe", args: ["-m", "byk.cli", "extract", "--json", "--paths-file", "{pathsFile}"] } },
  pathsFile: "C:/tmp/p.txt",
});
assert.deepEqual(spec2.args.slice(-2), ["--paths-file", "C:/tmp/p.txt"]);
step("自定义 command 支持 {pathsFile} 占位符");

const spec3 = resolveLocalExtractCommand("file", {
  config: { localExtract: { whisperModel: "medium", ocrLang: "en" }, roles: { file: { backend: "local-extract" } } },
  python: "py", pathsFile: "p.txt",
});
assert.deepEqual(spec3.args.slice(-4), ["--whisper-model", "medium", "--ocr-lang", "en"]);
step("whisperModel / ocrLang 透传");

assert.throws(() => resolveLocalExtractCommand("file", { config: cfgLE, pathsFile: "p.txt" }), /缺少 python/);
assert.throws(() => resolveLocalExtractCommand("file", { config: cfgLE, python: "py" }), /需要 pathsFile/);
assert.throws(
  () => resolveLocalExtractCommand("file", { config: { localExtract: { enabled: false } }, python: "py", pathsFile: "p.txt" }),
  /本地提取层未启用/,
);
assert.throws(() => resolveLocalExtractCommand("nope", { pathsFile: "p.txt" }), /unknown role/);
step("缺 python / 缺 pathsFile / 开关关掉 / 未知角色 都明确报错");

// ───────────────────────────────────────────────────────────────────────────
console.log("【5】路径抽取（纯函数，不碰文件系统）");
assert.equal(detectExtractKind("C:\\a\\b.PNG"), "image");
assert.equal(detectExtractKind("C:\\a\\b.pdf"), "document");
assert.equal(detectExtractKind("C:\\a\\b.mp3"), "audio");
assert.equal(detectExtractKind("C:\\a\\b.mp4"), "video");
assert.equal(detectExtractKind("C:\\a\\b.xyz"), "unknown");
assert.equal(extensionOf("C:\\a\\.gitignore"), "");
assert.equal(baseNameOf("C:\\a\\b.pdf"), "b.pdf");

const taskText = String.raw`帮我看看 C:\Users\me\报告.pdf 和 D:/data/shot.png，还有 C:\tmp\x.bin 以及 C:\Users\me\报告.pdf`;
const found = findExtractPaths(taskText);
assert.deepEqual(found.paths, ["C:\\Users\\me\\报告.pdf", "D:/data/shot.png"]);
assert.deepEqual(found.rejected, ["C:\\tmp\\x.bin"]);
assert.deepEqual(findExtractPaths("这段话里没有任何路径"), { paths: [], rejected: [] });
assert.deepEqual(findExtractPaths("").paths, []);
step("抽取绝对路径、去掉尾部标点、去重、把不支持的扩展名放进 rejected");

// ───────────────────────────────────────────────────────────────────────────
console.log("【6】本地提取层的解析与渲染");
assert.deepEqual(parseExtractOutput(""), { ok: false, reason: "empty-output", error: "" });
assert.equal(parseExtractOutput("[byk] 正在提取\n这不是 JSON").ok, false);
assert.equal(parseExtractOutput("[byk] 正在提取\n这不是 JSON").reason, "not-json");
assert.equal(parseExtractOutput('{"a":1}').ok, false, "没有 results 字段就不认");
const parsed = parseExtractOutput('[byk] 开始提取\n{"ok":true,"results":[]}\n[byk] 结束');
assert.equal(parsed.ok, true);
assert.deepEqual(parsed.payload.results, []);
step("stdout 里混着日志也能取到 JSON");

const payload = {
  ok: true,
  version: "1.0.0",
  supported_extensions: SUPPORTED_EXTENSIONS,
  results: [
    { path: "C:\\a\\shot.png", name: "shot.png", kind: "image", ok: true, text: "识别出来的字", meta: { method: "ocr:rapidocr" }, error: null, method: "ocr:rapidocr" },
    { path: "C:\\a\\talk.mp3", name: "talk.mp3", kind: "audio", ok: true, text: "转写文本", meta: {}, error: null, method: "whisper:small" },
  ],
};
const rep = formatExtractReport(payload, { python: "C:/py/python.exe", commandLine: "py -m byk.cli extract" });
assert.equal(rep.ok, true);
assert.equal(rep.model, "local:extract(faster-whisper+rapidocr-onnxruntime)");
assert.match(rep.text, /本地路径：本地提取层 rapidocr-onnxruntime（图片 OCR）/);
assert.match(rep.text, /本地路径：本地提取层 faster-whisper（语音转写）/);
assert.match(rep.text, /命令：py -m byk.cli extract/);
assert.match(rep.text, /未调用任何云端模型/);
assert.equal(rep.text.includes("装法："), false);
step("成功结果里打印真实走的本地路径，model = " + rep.model);

const mixed = formatExtractReport(
  { results: [{ path: "C:\\a\\x.pdf", kind: "document", ok: false, error: "缺少 pypdf", method: "" }] },
  { python: "C:/py/python.exe" },
);
assert.equal(mixed.ok, false, "部分失败不能算成功");
assert.equal(mixed.model, "local:extract");
assert.match(mixed.text, /失败：缺少 pypdf/);
assert.match(mixed.text, /装法：C:\/py\/python\.exe -m pip install pypdf python-docx python-pptx openpyxl/);
assert.equal(formatExtractReport({ results: [] }).ok, false);
step("缺库时点名装什么；部分失败不掩盖");

assert.equal(localModelLabel([]), "local:extract");
assert.equal(localModelLabel(["ocr:rapidocr"]), "local:rapidocr-onnxruntime");
assert.equal(localModelLabel(["pypdf"]), "local:pypdf");
assert.equal(
  localModelLabel(["whisper:small", "ocr:rapidocr", "whisper:small"]),
  "local:extract(faster-whisper+rapidocr-onnxruntime)",
);
assert.equal(describeLocalMethod("image", "ocr:rapidocr"), "本地提取层 rapidocr-onnxruntime（图片 OCR）");
assert.equal(describeLocalMethod("video", "whisper:small"), "本地提取层 faster-whisper（视频抽帧 + 语音转写）");
assert.equal(describeLocalMethod("document", "pypdf"), "本地提取层 pypdf（文档解析）");
step("本地标识与本地路径文案");

// ───────────────────────────────────────────────────────────────────────────
console.log("【7】禁止静默回落云端（失败文案）");
const reasons = ["no-path", "path-unsupported", "missing-cli", "spawn-failed", "empty-output", "not-json", "exit"];
for (const reason of reasons) {
  const t = localExtractFailureText({ reason, python: "C:/py/python.exe", code: 3 });
  assert.ok(t.includes(NO_FALLBACK_NOTE), reason + " 必须逐字带上「不回落」说明");
  assert.match(t, /没有成功，也没有改用云端模型/);
  assert.match(t, /本地提取层的 python：C:\/py\/python\.exe/);
  assert.ok(t.includes(SUPPORTED_EXTENSIONS_TEXT), reason + " 必须列出支持的扩展名");
}
assert.match(localExtractFailureText({ reason: "no-path" }), /绝对路径/);
assert.match(
  localExtractFailureText({ reason: "path-unsupported", rejected: ["C:\\tmp\\x.bin"] }),
  /没被接受：C:\\tmp\\x\.bin/,
);
assert.ok(localExtractFailureText({ reason: "missing-cli" }).includes(EXTRACT_CLI_PATCH_FILE));
assert.match(localExtractFailureText({ reason: "missing-cli" }), /extract 子命令/);
assert.match(localExtractFailureText({ reason: "spawn-failed", detail: "spawn EPERM" }), /原始信息：spawn EPERM/);
assert.match(localExtractFailureText({ reason: "exit", code: 3, stderr: "boom" }), /退出码 3/);
step(reasons.length + " 种失败原因的文案都点名「缺什么 / 装什么 / 支持哪些扩展名 / 不换云端」");

assert.equal(installHint("image", "C:/py/python.exe"), "C:/py/python.exe -m pip install rapidocr-onnxruntime");
assert.match(installHint("audio", "py"), /faster-whisper/);
assert.match(installHint("video", "py"), /faster-whisper rapidocr-onnxruntime/);
assert.equal(installHint("text", "py"), "", "纯标准库类型没有装法可说");
assert.equal(looksLikeMissingSubcommand("byk: error: argument cmd: invalid choice: 'extract' (choose from 'serve', 'agent')"), true);
assert.equal(looksLikeMissingSubcommand("ModuleNotFoundError: No module named 'byk'"), false);
step("装库提示与「没有 extract 子命令」的识别");

// ───────────────────────────────────────────────────────────────────────────
console.log("【8】describeEffectiveRoute（给设置页 s5 的只读描述）");
const peakD = describeEffectiveRoute("task", { now: peakSec });
assert.equal(peakD.source, "peak");
assert.equal(peakD.sourceDetail, "routing.peak");
assert.equal(peakD.text, formatRoute(resolveRoute("task", { now: peakSec })));
assert.match(peakD.summary, /高峰/);
assert.deepEqual(Object.keys(peakD).sort(), [
  "backend", "model", "phase", "provider", "reasoningEffort", "roleId", "routed",
  "sandbox", "source", "sourceDetail", "summary", "text", "timeoutMs",
]);

const valleyD = describeEffectiveRoute("task", { now: valleySec });
assert.equal(valleyD.source, "off-peak");
assert.match(valleyD.text, /低谷/);

const visionD = describeEffectiveRoute("vision", { now: peakSec });
assert.equal(visionD.source, "default");
assert.equal(visionD.text, "xiaomi/mimo-v2.6-flash ｜固定路由");

const asrD = describeEffectiveRoute("audio", { now: peakSec });
assert.equal(asrD.source, "asr");
assert.equal(asrD.text, "直连 ASR mimo-v2.5-asr → mimo-v2.6-flash");

const ovD = describeEffectiveRoute("task", { now: peakSec, overlay: overlayOv });
assert.equal(ovD.source, "role-override");
assert.equal(ovD.text, "deepseek-official/deepseek-v4-flash ｜逐助手覆盖");
assert.match(ovD.summary, /压过峰谷/);

const leD = describeEffectiveRoute("vision", { now: peakSec, overlay: overlayLE });
assert.equal(leD.source, "local-extract");
assert.equal(leD.model, "local:extract");
assert.match(leD.summary, /不调用任何 LLM/);

const localD = describeEffectiveRoute("file", { now: peakSec, config: cfgLocal });
assert.equal(localD.source, "local");
assert.equal(localD.text, "本地后端");

const cfg = resolveConfig();
assert.ok(cfg.roles.task && cfg.roles.code, "resolveConfig 仍然产出 7 个角色");
assert.equal(Object.keys(cfg.roles).length, Object.keys(DEFAULT_ROLES).length);
step("source 取值域 role-override | peak | off-peak | default | local | local-extract | asr");

console.log("\n全部通过 ✓");
