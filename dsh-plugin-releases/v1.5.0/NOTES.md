# v1.5.0 — Jev 接入（2026-10-06）

> 本目录是 `C:\Projects\byk\dsh-plugin` 在 2026-10-06 的逐字节快照（19 个插件文件 + 本 NOTES.md + MANIFEST.json）。
> 这一版把 TypeSafe 的 Jev（System One）接成本插件的「判断原语」：新增 `byk_judge` / `byk_judge_batch`
> 两个工具与 `lib/jev.js`，指令层写入「判断先行」，并配套新增测试与规划规约。
> **`v1.4.2\` 归档原样未动**（本次归档没有读写任何既有归档）。

## 一、本轮改了什么

| 文件 | 字节 | 改动 |
| --- | --- | --- |
| `lib/jev.js` | 18117 | **新增**：Jev 调用层（`createJevCaller` / `resolveApiKey` / `keyFileCandidates` / `buildQuestion` / `validateQuestion` / `normalizeHttpError` / `toJudgeJson` / `toBatchJson` / `compactAnswer` / `truncateText` / `QUESTION_TYPES`） |
| `lib/index.js` | 55579 | 注册 `byk_judge`（lib/index.js:944）与 `byk_judge_batch`（lib/index.js:1013）；新增配置段 `jev`（lib/index.js:196）；工具说明与指令层写入「判断先行」（lib/index.js:109 / :116 / :118） |
| `lib/plan.js` | 11152 | 规划指令要求把判断写进该步 acceptance（lib/plan.js:53、lib/plan.js:55） |
| `test/jev.test.js` | 17976 | **新增**：14 组断言，桩 fetch、不联网 |
| `docs/jev-planning-spec.md` | 19332 | **新增**：Jev 用法的科研规约（本插件 Jev 契约来源，见 lib/index.js:918 注释） |
| `readme.md` | 23031 | 新增「Jev 判断」章节（readme.md:37 起）、工具表两行（readme.md:30-31）、`jev` 配置示例（readme.md:105）、`byk_judge` 自述（readme.md:124） |
| `package.json` | — | `version` 1.4.2 → 1.5.0；`files` 收录 `lib/jev.js`、`test/jev.test.js`（**依赖段一字未改**） |

`files` 数组没有收录 `docs/`：它是设计/科研依据，运行时不加载（`lib/*.js` 不 import 它），
既有 `files` 也从不收录 `docs/`；归档仍然把 `docs/` 全量收进来，回退不受影响。

## 二、关键证据（s1 / s3 / s4，来自本轮上游步骤的记录）

1. **s1 真实调用面**：上游步骤做过 3 次**真实** Jev 调用（非桩），返回带 `value` / `confidence` 的类型化判定。
   其中一条落地为「**文档说 422、实测 400**」：`readme.md:89` 记录
   `| invalid | HTTP 400/422：请求体被服务端拒绝（文档写 422、实测 400） |`；
   于是 `choice` / `score` 缺 `criteria` 在**本地**先拦下（`error_kind=config`，见 readme.md:100、代码 lib/index.js:976），
   不白打一次必然 400 的请求。`lib/index.js:199` 注释记录实测模型版本 `jev-1.13.0`。
2. **s3 调用层**：`test/jev.test.js` 14 组断言，覆盖解析 / 错误归一化 / 超时 / 缺 key 报错 / 返回 JSON 形状，全部桩 fetch、不联网。
3. **s4 测试面**：`node --check`、jev、plan、timing 等入口 exit 0。

## 三、本次归档时实跑的验证（2026-10-06，下列全部是本次真实输出）

| 命令 | 结果 |
| --- | --- |
| `node --check lib\{asr,client,index,jev,plan,routing,timing}.js` | 7/7 exit **0** |
| `node --check` test 下 6 个入口 + `scripts/asr-mimo.mjs` | 7/7 exit **0** |
| `node test/jev.test.js` | exit **0** |
| `node test/plan.test.js` | exit **0** |
| `node test/timing.test.js` | exit **0** |
| `node test/run-smoke.mjs` | exit **0** |
| 归档 vs 工作树逐文件 sha256 | identical 20/20，不一致列表 **空** |

## 四、已知环境问题（与 v1.5.0 代码无关）

`test/run-smoke.mjs:36` 会在临时目录里为 `@deepseek-ai\*` 建符号链接；在**没有符号链接权限**的环境里它会以
`Error: EPERM: operation not permitted, symlink ...` 结束。本次归档运行的结果：**exit 0**（该运行环境下符号链接可用）。
需要完整测试面时，请在允许符号链接的环境（或开启了开发者模式的普通终端）里重跑；v1.5.0 没有改过这个文件。

## 五、回退办法

### （a）单文件回退 —— 只撤掉 Jev 入口（插件退回 v1.4.2 的 lib/index.js，新文件留在原地但不再被引用）

```powershell
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.2\lib\index.js' 'C:\Projects\byk\dsh-plugin\lib\index.js' -Force
```

### （b）整版回退到 v1.4.2 —— 覆盖旧文件 + 删掉本轮新增的三个文件

```powershell
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.2\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force; Remove-Item -Force 'C:\Projects\byk\dsh-plugin\lib\jev.js','C:\Projects\byk\dsh-plugin\test\jev.test.js','C:\Projects\byk\dsh-plugin\docs\jev-planning-spec.md'
```

`package.json` 的 version 会被快照里的 1.4.2 覆盖回来；`node_modules` 与 `.git` 不受影响。

### ⚠️ 不要用 `rollback.mjs` 回退本系列归档

`rollback.mjs` 按 `files[].relPath` 取路径（rollback.mjs:53、rollback.mjs:103、rollback.mjs:121/124），
而本系列 MANIFEST 用的键是 `path`（v1.4.1 / v1.4.2 / v1.5.0 都一样）。实测（本次真实输出）：

```
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.4.2 --dry-run
→ TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined
    at Object.join (node:path:513:7)
    at file:///C:/Projects/byk/dsh-plugin-releases/rollback.mjs:121:20
退出码 1；并且第 2 步把插件目录里 70 个真实文件全部误报为 EXTRA（因为 expected 里的 relPath 全是 undefined）。
```

修法二选一（**本轮未改**）：① MANIFEST 里补一个与 `path` 同值的 `relPath` 字段；
② 把 rollback.mjs 的 `e.relPath` 改成 `(e.relPath ?? e.path)`。

## 六、附：package.json 的 files 数组（归档版本原文）

```json
    ".gitignore",
    "agents.config.example.json",
    "cordis.patch.yml",
    "docs/jev-planning-spec.md",
    "lib/asr.js",
    "lib/client.js",
    "lib/index.js",
    "lib/jev.js",
    "lib/plan.js",
    "lib/routing.js",
    "lib/timing.js",
    "package.json",
    "readme.md",
    "scripts/asr-mimo.mjs",
    "test/client-approval.test.js",
    "test/jev.test.js",
    "test/plan.test.js",
    "test/run-smoke.mjs",
    "test/smoke.test.js",
    "test/timing.test.js"
```
