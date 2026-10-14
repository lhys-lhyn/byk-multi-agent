# dsh-plugin-byk-agents

把「七个专业助手 + 计划确认 → 分派执行 → 进度汇报 → 汇总交付」这一整套协作流程，做成 DSH 里的标准 bundle 插件。
主对话只负责跟用户对话、拿计划、派活、汇报、汇总；具体活由七个角色各自用**自己的模型与人格**在独立上下文里干。

> 当前版本 **1.2.0**。v1.2.0 新增两样东西：① `subagentTools` 配置键（把「子智能体复用宿主插件工具」写成契约，并提供收窄手段）；② 客户端模块 `lib/client.js`（把**其它会话**的审批事件镜像到主对话）。后者**必须完整重启 DSH 才会被加载**。

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
- **真实 provider 的 `caps.toolFilter` 真值未核实**（只验到桩给的 caps）；`inherit-all` 默认路径不受此影响。

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

## 客户端模块 `lib/client.js`（v1.2.0 新增）

模块注册 id：`dsh-plugin-byk-agents`（**必须是包名**，不是 entry 名 `byk-agents`——写成 entry 名浏览器端会取不到）；
`package.json` 声明 `exports["./client"] = "./lib/client.js"` 与 `dsh.client = { "platform": "web", "inject": [] }`。
**手写 bundle，无构建步骤**（与 dsh-approval-gate 同款），URL 规则 `/plugins/??<包名>/client.js&rev=<rev>`。

**它干什么**：把**其它会话**的 approval-gate 审批事件镜像到主对话——① `conversation.input.dock` 槽（order 31，
紧跟原生条 order 30 之后）的提示条，带来源标签「其它会话 · <短 id>」；② `conversation.view` 槽上多一个
「跨会话审批」页签（order 21，排在原生「审批」之后）。数据源是每 5 秒轮询 `GET /api/auto-approve/events`
（**不带 `sessionId`**，服务端该参数可选、不传即不过滤，`src\index.mjs:739`），按每条事件自带的
`sessionId`（`src\index.mjs:290`）标注来源后展示。**当前会话的事件一律 `continue` 掉**，交给原生条——
同一事件永远不会出现两条提示条。

**它不干什么（诚实边界，别当成故障）**：

1. **子智能体（`byk_role` / `byk_plan` / `byk_batch` 拉起的子会话）的审批看不到，也不会被本模块看到。**
   DSH 把子会话的审批策略钉死为 `never`（`dsh-user-approval\lib\index.js:175`：
   `if (this.effectivePolicy(session) === "never") return "rejected";`），需要审批的动作在子会话里
   **直接被自动拒绝**、根本不产生 gate 事件，镜像条无从显示。要让子智能体的审批弹给人，必须改 **DSH 上游**
   （`packages/subagent/subagent-in-process-driver` 的 delegation 策略继承，或
   `packages/interaction/user-approval` 的 policy 短路分支）——**超出本插件职责范围**。
   插件侧已在子智能体提示词里写明这条（`lib\index.js:112`）：高风险动作在子会话里会被自动拒绝而不是弹给人确认。
2. **当前会话自己的审批不显示**——按设计让给 dsh-approval-gate 的原生条，避免双条。
3. 只有**其它会话真的跑在 auto-approve preset 上**并产生事件时才会出现东西；没有事件时提示条**完全不渲染、不占位**。
4. 拿不到当前会话 id 时（`useSessions` 不可用），镜像功能整体静默停用、只显示一行说明，不报错、不影响对话。
5. 本模块是**替代实现**，不是 dsh-approval-gate 的增强；它一个字节都没改 dsh-approval-gate。

**必须完整重启 DSH 才会被加载。** 客户端模块清单在**进程启动那一刻**快照、仅在 loader entry 变更时重算，
`package.json` 变更不触发重算。实测：插件 fiber active 时热重载（setPluginEnabled false→true）之后，
`GET /plugins/??dsh-plugin-byk-agents/client.js` 仍是 **404**、首页 `window.__DSH_BOOT__` 清单里 **"byk" 零命中**
（对照组 `dsh-approval-gate` 同一 URL 形状 200 / 59033 字节）。

重启后自检（一条命令，200 即可）：

```powershell
node C:\Projects\byk\.byk-work\check-client-bundle.mjs
```

200 = 运行时已认这个包；仍 404 = 还有第二处静态阻塞，请把 DSH 启动日志里含 `client-modules:` 的行发出来。
页面侧对照：F12 → Console 执行 `JSON.stringify(window.__DSH_BOOT__).includes('dsh-plugin-byk-agents')`，期望 `true`。

## 测试

```
node test/timing.test.js    # 峰谷判定 16 例 + 路由/自定义配置/禁用模型
node test/plan.test.js      # 计划解析/规范化/依赖分批/计划书渲染
node test/run-smoke.mjs     # 冒烟：真加载 lib/index.js（假 ctx），验注册/分派/防递归/本地后端/计划批量
```

`test/run-smoke.mjs` 会把 `lib/` 复制到临时目录再跑，避免插件目录里放 `dsh-tools` 遮蔽宿主真包。
前两个不依赖 DSH 运行时，可以单独跑。

`node --check` 覆盖 `lib` 下全部 `.js`（v1.2.0 共 6 个）应全部 exit 0。
**`node test/smoke.test.js` 在本机必然失败**（`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`）——
`lib/index.js` 的 `@deepseek-ai/*` 由 DSH loader 解析，直接在插件目录跑 node 找不到宿主包。这是**既有现象，不是回归**；
`test/run-smoke.mjs` 通过就等价于同一套断言在等价条件下通过。
