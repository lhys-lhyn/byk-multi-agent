# dsh-plugin-byk-agents

把「七个专业助手 + 计划确认 → 分派执行 → 进度汇报 → 汇总交付」这一整套协作流程，做成 DSH 里的标准 bundle 插件。
主对话只负责跟用户对话、拿计划、派活、汇报、汇总；具体活由七个角色各自用**自己的模型与人格**在独立上下文里干。

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

## 安装

标准 bundle：`package.json` 里声明 `dsh.bundle.patch = ./cordis.patch.yml`，补丁往 profile 里插一条 `byk-agents` 条目。
装法（desktop profile 由 Electron 应用独占，CLI 进不去）：走应用自身的 pluginManager RPC——
`POST http://127.0.0.1:<port>/api/pluginManager/installBundle`，`args.spec` 用**绝对路径**，
`payload` 里只放 `args` 一个字段；鉴权用 `.credentials.yaml` 的 `client-connection/browser-session` secret 现场签 `dsh-auth-*` cookie。

装完在 profile 的 `package.json` 里是 `link:C:/Projects/byk/dsh-plugin`（改代码不用重装，但**新工具要重启 DSH**
或关开一次插件让 fiber 重载才出现在会话里）。

## 测试

```
node test/timing.test.js    # 峰谷判定 16 例 + 路由/自定义配置/禁用模型
node test/plan.test.js      # 计划解析/规范化/依赖分批/计划书渲染
node test/run-smoke.mjs     # 冒烟：真加载 lib/index.js（假 ctx），验注册/分派/防递归/本地后端/计划批量
```

`test/run-smoke.mjs` 会把 `lib/` 复制到临时目录再跑，避免插件目录里放 `dsh-tools` 遮蔽宿主真包。
前两个不依赖 DSH 运行时，可以单独跑。
