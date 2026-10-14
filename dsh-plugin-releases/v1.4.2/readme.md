# dsh-plugin-byk-agents

把「七个专业助手 + 计划确认 → 分派执行 → 进度汇报 → 汇总交付」这一整套协作流程，做成 DSH 里的标准 bundle 插件。
主对话只负责跟用户对话、拿计划、派活、汇报、汇总；具体活由七个角色各自用**自己的模型与人格**在独立上下文里干。

> 当前版本 **1.4.2**。变更主线：v1.2.0 加了 `subagentTools` 契约与客户端模块；v1.3.0–v1.3.1 加了**子智能体待批审批条**（在主对话里直接点「允许一次 / 拒绝」）；v1.4.0 把整条审批链路依赖的两处本机兼容补丁写进文档；v1.4.1 让待批条「一条都不漏」；v1.4.2 订正文档里已过时的边界描述与自检命令。

## 七个助手

| 角色 | 干什么 | 默认模型 |
| --- | --- | --- |
| `task` 任务助手 | 把诉求拆成子任务并指派角色 | 峰谷（见下） |
| `code` 代码助手 | 代码审查、排障、跑命令、构建、部署 | 峰谷（见下） |
| `search` 搜索助手 | 全网检索并汇总，带出处 | 峰谷（见下） |
| `vision` 视觉助手 | 看图、看视频画面、OCR | `xiaomi/mimo-v2.6-flash` |
| `file` 文件助手 | Word / PPT / PDF / Excel 内容提取 | `xiaomi/mimo-v2.6-flash` |
| `research` 科研助手 | 科研问题分析、文献检索、成果综述 | `xiaomi/mimo-v2.6-pro`（角色白名单放行） |
| `audio` 语音助手 | 语音转写 → 理解与结构化 | 直连 `xiaomi/mimo-v2.5-asr`，理解用 `xiaomi/mimo-v2.6-flash` |

模型映射是**用户口径**，不是仓库旧配置：`file`/`vision` 用 `mimo-v2.6-flash`，`audio` 用 mimo 语音模型。

## 工具

| 工具 | 作用 |
| --- | --- |
| `byk_plan` | 把用户原始诉求交给任务助手，返回结构化计划（每步带 `role` / `depends_on` / `acceptance` / `estimate_min`）与可执行的 `plan_json` |
| `byk_batch` | 按 `depends_on` 拓扑分批、批内并发执行整份计划，把前置步骤结论自动拼进下一步任务说明，返回逐条结果 + 执行汇总 |
| `byk_role` | 单个角色的一次委派（计划里每步一条，也用于单点调用） |
| `byk_hire` | 把一个 BYK 角色招成 Agent Team 里的具名 teammate（长期协作、要在任务板上跟进度时用） |

注入的协作流程要求：拿到计划先用 `todo_write` 登记进度清单，**再把计划摆给用户确认**（可改派角色、增删步骤、调顺序），
确认后才分派；每批返回后报一行进度（`进度 x/y（百分比）`、谁在做、什么模型、耗时、还剩几步），
**不许编造百分比或预计时间**；没有依据就退化成「已完成 x/y 步 + 每步耗时」。

## 峰谷路由（与 `switch-dsh-model.ps1` 同源）

`task`、`code`、`search` 三个助手在**每次调用时**按北京时间重新选模型，不改会话默认模型、不动你在 UI 里选的模型：

> `research`（科研助手）**不参与峰谷**，固定 `xiaomi/mimo-v2.6-pro`——它同时在全局禁用名单里，靠角色级
> 白名单 `allowForbiddenModels` 放行；只有它一个角色有这条白名单，`mimo-v2.6-pro-ultraspeed` 仍全局全禁。

| 时段 | 模型 | reasoningEffort |
| --- | --- | --- |
| 高峰（工作日 09:00-12:00、14:00-18:00） | `xiaomi/mimo-v2.6-flash` | 不下发（与脚本 `$script:PeakSelection` 一致） |
| 低谷（其余时段 + 周末 + 法定节假日） | `deepseek-official/deepseek-flash` | `high` |

低谷那条 `deepseek-flash` 就是 DeepSeek-V4.1-Flash 本身（上游 `GET https://api.deepseek.com/v1/models` 里
`id=deepseek-flash` 的显示名是 `DeepSeek-V4.1-Flash`；写 `deepseek-v41-flash` 会被上游 400 拒掉）。

口径抄自 `C:\Projects\dsh\model-switcher\switch-dsh-model.ps1`（**只读，从未修改**）：
`PEAK_HOURS=[[9,12],[14,18]]`；北京时间 2026-08-23 起周末全天谷价；2026-09-19 起法定节假日全天谷价；
节假日日期表依据国办发明电〔2025〕7 号。已用脚本自身的 `-Status -Port 1`（只读、不碰任何会话）
对 7 个时刻做交叉验证，`lib/timing.js` 与脚本判定**完全一致**。

## 配置

复制 `agents.config.example.json` 成 `agents.config.json`，放到插件目录或 `bykRoot` 下即可覆盖；
也可以给插件配置项 `routingConfigPath` 指定绝对路径。没写的键一律沿用 `lib/routing.js` 的默认值。

| 键 | 作用 |
| --- | --- |
| `planRole` | 谁出计划，默认 `task` |
| `maxParallel` | `byk_batch` 批内并发上限，默认 `3` |
| `subagentTools` | 子智能体可见哪些工具，默认 `"inherit-all"`（继承父会话全部，含其它已装插件的全局工具）；收窄写 `{ "deny": [...] }`。非法值**加载即报错**，详见下节 |
| `routing.appliesTo` | 哪些角色参与峰谷切换，默认 `["task","code","search"]` |
| `routing.peak` / `routing.offPeak` | 两条目标路由（`provider` / `model` / 可选 `reasoningEffort`） |
| `routing.peakHours` / `weekendValleyFromSec` / `holidayValleyFromSec` / `holidays` | 时段与节假日表，口径变了改这里 |
| `rolesFrom` | `routing`（默认，用本插件的角色表）或 `registry`（用 BYK `roles.py` 的实时模型） |
| `roles.<角色>` | 固定路由：`provider` / `model` / `reasoningEffort` / `sandbox` / `timeoutMs` / `persona` |
| `roles.<角色>.allowForbiddenModels` | 该角色可越过的禁用名单条目（逐个精确匹配）。目前只有 `research` 有：`["mimo-v2.6-pro"]` |
| `roles.<角色>.backend` | `llm`（默认）或 `local` —— **本地处理**：不调用任何大模型 |
| `roles.<角色>.local` | `{ enabled, command, args, timeoutMs }`，`args` 里可用 `{task}` / `{cwd}` 占位符 |
| `roles.audio.asr` | 语音直连：`{ baseURL, model, apiKeyEnv }` |
| `forbiddenModels` | 硬拦名单，默认 `["deepseek-v4-pro","mimo-v2.6-pro","mimo-v2.6-pro-ultraspeed"]` |

优先级：峰谷（仅 `appliesTo` 内的角色）> `rolesFrom` 指定的角色模型 > 内置默认。
`persona` / `sandbox` / 超时始终优先取 BYK 注册表（`byk.cli roles --json`）的实时值。

### 让别人也能用

角色表、峰谷口径、禁用名单、本地后端全部走配置，不改代码：

- 不想要大模型：把某个角色的 `backend` 设成 `local` 并给 `local.command`（例：`roles.file.local = { enabled: true, command: "python", args: ["extract.py", "{task}"] }`）。
- 换峰谷口径：改 `routing.peakHours` / `peak` / `offPeak`，或干脆 `routing.enabled=false` 关掉峰谷走固定路由。
- 换角色模型：`roles.<角色>.provider` / `.model`。

## 子智能体工具复用（v1.2.0 新增）

`byk_role` / `byk_plan` / `byk_batch` 拉起的子智能体，其工具集**默认就是调用方会话的全部工具**——
包括 DSH 内置工具与**其它已安装插件注册的全局工具**。这不是本轮新加的能力，而是既有事实：
BYK 从不设 `composition.toolFilter`（插件目录全目录 grep `toolFilter` 零命中），
于是 `dsh-subagent\lib\index.js:522` 的 `if (composition.toolFilter !== void 0) childCtx.tools.restrict(composition.toolFilter);` 整行不执行。

v1.2.0 做的是把这条事实**写成契约**、并补上收窄手段：

- `SUBAGENT_TOOL_REUSE`（`lib\index.js:108-116`）：每次派活都在任务说明后追加一段「工具复用约定」，
  要求子智能体**先扫系统提示里的工具清单、能复用现成工具就别重写**。这段文本**不含任何工具清单**（清单本身要付 token）。
- `subagentTools` 配置键：默认 `"inherit-all"`，即**不传** `toolFilter`，子会话继承父会话全部工具。

| 写法 | 含义 |
| --- | --- |
| `"subagentTools": "inherit-all"`（默认，与不写该键完全等价） | 不设 `toolFilter`，继承全部（`lib\index.js:163`） |
| `{ "deny": ["read"] }` | 透传给 `ctx.subagents.start` 的 `toolFilter`，在父会话工具集**之内**再收窄 |
| `{ "allow": ["byk_role"] }` | 同上，白名单式收窄（漏写一项会让工具消失，所以推荐用 `deny`） |
| `{ "allow": [], "deny": [] }` | **加载期直接抛错**，不静默降级成「继承全部」（`lib\index.js:166-171`） |
| 其它非法值 | schemastery 校验失败，插件加载报错 |

边界（实测结论，原始证据见 `C:\Projects\byk\dsh-plugin-releases\v1.2.0-notes.md`）：

- `restrict()` 是**交集**语义，因此**子会话工具集 ⊆ 父会话工具集**——「放开」不等于子智能体能碰到父会话碰不到的东西。
- 收窄**依赖 provider 支持 `toolFilter`**：`pickProvider()`（`lib\index.js:338-340`）只挑 `caps.toolFilter === true` 的 provider；
  挑不到时**明确报错且 `startCalls=0`**，不静默忽略、也不回退到独立进程路径（`lib\index.js:444-451`）。
- **`caps.toolFilter` 真值已核实**：两个进程内 provider 都声明 `toolFilter: true`（`@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:41`、`@deepseek-ai\dsh-subagent-spawn-in-process\lib\index.js:27`）；只有**进程外** provider 声明 `false`（`@deepseek-ai\dsh-subagent\lib\index.js:2527`、`lib\types\out-of-process.js:53`）→ 用本机默认的进程内 provider 时收窄可用，切到进程外 provider 才会撞上 `UNSUPPORTED_CAPABILITY`（`dsh-subagent\lib\index.js:3188-3196`）；`inherit-all` 默认路径与 provider 无关。
- **继承已实测（v1.4.2）**：`byk_role(code)` 拉起的子智能体直接调用 `tools.ego_status({})`（`dsh-ego-browser` 插件注册的全局工具，非宿主内置）→ 返回 `{"ok":true,"available":true,"path":"…dsh-ego-browser\runtime\ego-linux\bin\ego-browser.mjs","exitCode":0}`；子会话自报工具总数 101、其中 `ego_*` 35 个。即「子智能体继承调用方全部工具，含其它已装插件注册的工具」在真实运行环境成立。

## 运行前置：本机两处兼容补丁

本插件依赖两个「本机 DSH 补丁」才能完整工作（都在 `C:\Projects\byk\.byk-work\`，那里有唯一一份说明与回退命令）：

| 补丁 | 作用 | 工具 | 生效条件 |
| --- | --- | --- | --- |
| DSH 本体 `app.asar`（7 字节等长替换） | 子会话的审批策略由写死的 `never` 改为 `ask`，子智能体的提权请求才会冒泡到主对话 | `patch-asar.mjs` | 完全退出 DSH 后重启 |
| `dsh-approval-gate` 源码兼容补丁 | gate v0.5.0 调 `permissionPresets.current(session.events)`，本机运行时签名是 `current(session)`，抛错被 gate 自己吞掉 → 它对所有审批**零介入**；补丁先传 `session`、失败再回退旧写法 | `patch-gate.mjs` | 完全退出 DSH 后重启（模块在进程内缓存） |

两个补丁都不改变接口与数据格式，可随时回退（回退命令见 `.byk-work\README.md`；DSH 升级或重装插件后需重打）。

## 安装

标准 bundle：`package.json` 里声明 `dsh.bundle.patch = ./cordis.patch.yml`，补丁往 profile 里插一条 `byk-agents` 条目。
装法（desktop profile 由 Electron 应用独占，CLI 进不去）：走应用自身的 pluginManager RPC——
`POST http://127.0.0.1:<port>/api/pluginManager/installBundle`，`args.spec` 用**绝对路径**，
`payload` 里只放 `args` 一个字段；鉴权用 `.credentials.yaml` 的 `client-connection/browser-session` secret 现场签 `dsh-auth-*` cookie。

装完在 profile 的 `package.json` 里是 `link:C:/Projects/byk/dsh-plugin`（改代码不用重装，但**新工具要重启 DSH**
或关开一次插件让 fiber 重载才出现在会话里）。

> ⚠️ **v1.2.0 起，客户端模块必须完整重启 DSH 才会被加载，插件热重载不够**——原因与验证方法见下节。

> ⚠️ **鉴权配方（实测修正）**：`.credentials.yaml` 里 `client-connection/browser-session` 那串 43 字符
> base64url 是**编码后的 32 字节密钥**，必须 **base64url 解码成字节**再作为 HMAC-SHA256 的 key。
> 直接拿字符串当 key → **401**，body 恰好是 12 字节非 JSON 的 `unauthorized`；解码后（`secretBytes=32`）同一请求 → **200**。

## 客户端模块 `lib/client.js`

模块注册 id：`dsh-plugin-byk-agents`（**必须是包名**，不是 entry 名 `byk-agents`——写成 entry 名浏览器端会取不到）；
`package.json` 声明 `exports["./client"] = "./lib/client.js"` 与 `dsh.client = { "platform": "web", "inject": [] }`。
**手写 bundle，无构建步骤**（与 dsh-approval-gate 同款），URL 规则 `/plugins/??<包名>/client.js&rev=<rev>`。

它干两件事：

**① 子智能体待批审批条**（v1.3.0 起；`conversation.input.dock`，order 25）——等待人工的审批在主对话里
直接显示「工具 / 要做什么（完整原因）/ 来源会话 / 已等待 xx 秒」和「拒绝 / 允许一次」两个按钮。
数据源是 `uiSession.sessionStatus` 的全局待批快照（`getSnapshot()` + `subscribe`），
应答走 `pending.answer('allowed-once' | 'rejected')`（与原生卡片同一套词表）。

**显示规则（v1.4.1 定稿：宁可多显示，绝不漏）**：所有已知的待批审批都渲染；只有**本会话自己那条**在页面上
已经存在原生审批面板时（`document.querySelector('[class*="ApprovalPanel_module"]')` 命中）才让位给它——
既不会出现两套按钮，也不会出现「两边都不显示」的空档。来源标签区分 `本会话 / 子会话 / 其它会话`。

**② 跨会话审批镜像**（v1.2.0 起）——把**其它会话**的 approval-gate 审批事件镜像到主对话：
`conversation.input.dock`（order 31，紧跟原生条 order 30 之后）的只读提示条（带「其它会话 · <短 id>」标签），
以及 `conversation.view` 上多一个「跨会话审批」页签（order 21）。数据源是每 5 秒轮询
`GET /api/auto-approve/events`（**不带 `sessionId`**，服务端该参数可选、不传即不过滤，`src\index.mjs:739`），
按每条事件自带的 `sessionId`（`src\index.mjs:290`）标注来源；**当前会话的事件一律 `continue` 掉**交给原生条，
同一事件永远不会出现两条镜像提示。

诚实边界（别当成故障）：

1. 待批条依赖**两处本机补丁**（见上节）：没有 asar 那 7 字节，子会话的审批策略是 `never`，压根不产生待批请求；
   没有 gate 兼容补丁，低风险请求不会被自动放行。两处都打好、且会话 preset 选「自动审批（Flash）」时，
   低风险自动放行、高风险转人工——两条链路均已实测（证据见 `dsh-plugin-releases\v1.4.1\NOTES.md`）。
2. 镜像条只覆盖 dsh-approval-gate 的**事件流**：只有其它会话真的跑在 auto-approve preset 上并产生事件时才出现；
   没有事件时提示条**完全不渲染、不占位**。
3. 拿不到 `uiSession` 时两项功能都静默停用、不报错、不影响对话。
4. 本模块是 dsh-approval-gate 的**补充**：它一个字节都没改 dsh-approval-gate。

**加载时机**：客户端模块清单在**进程启动那一刻**快照，所以**第一次新增/删除**这个客户端模块需要完整重启 DSH；
**只改文件内容不用重启**——宿主按 mtime/size 重算 `rev`，**刷新页面**即可拿到新 bundle（实测多次）。

自检（改完 `lib/client.js` 后）：F12 → Network 刷新页面，应看到
`plugins/??dsh-plugin-byk-agents/client.js&rev=<hex>` 返回 200（`rev` 变了 = 新 bundle 已被取走）；
Console 里 `JSON.stringify(window.__DSH_BOOT__).includes('dsh-plugin-byk-agents')` 期望 `true`。

## 测试

```
node test/timing.test.js            # 峰谷判定 16 例 + 路由/自定义配置/禁用模型
node test/plan.test.js              # 计划解析/规范化/依赖分批/计划书渲染（10 例）
node test/client-approval.test.js   # 客户端 bundle：待批选择/让位规则/应答词表/渲染树（20 例，桩 React）
node test/run-smoke.mjs             # 冒烟：真加载 lib/index.js（假 ctx），验注册/分派/防递归/本地后端/计划批量
```

`test/run-smoke.mjs` 会把 `lib/` 复制到临时目录再跑，避免插件目录里放 `dsh-tools` 遮蔽宿主真包。
前两个不依赖 DSH 运行时，可以单独跑。

`node --check` 覆盖 `lib` 下全部 `.js`（v1.4.2 共 6 个：`index/client/plan/routing/timing/asr`）应全部 exit 0。
**`node test/smoke.test.js` 在本机必然失败**（`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`）——
`lib/index.js` 的 `@deepseek-ai/*` 由 DSH loader 解析，直接在插件目录跑 node 找不到宿主包。这是**既有现象，不是回归**；
`test/run-smoke.mjs` 通过就等价于同一套断言在等价条件下通过。
