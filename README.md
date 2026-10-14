# BYK · 多智能体协作系统

一个**真正由多个独立智能体协作**完成复杂任务的系统。你只跟"主对话"说话，它负责理解、拆解、确认、派发、回收、汇总。

每个助手都是一个**独立的 DSH 无头智能体进程**——有自己的上下文、工具链、人格和模型路由，不是同一个模型换几句提示词。

---

## 1. 架构

```
                    ┌──────────────────────────────┐
   你的文字/文件 ──▶ │  主对话（编排器，确定性代码）  │
                    └──────────────┬───────────────┘
                                   │
                  ① 本地提取：PDF/DOCX/PPTX/图片/音视频
                                   │
                  ② 任务助手 ──▶ PLAN.json（结构化子任务）
                                   │
                  ③ 计划回给你确认（可改派角色、可改说明）
                                   │
                  ④ 按依赖分层并发派发 ──▶ 各助手独立进程
                                   │
                  ⑤ 提权拦截 ──▶ 你点确认 ──▶ 编排器执行 ──▶ 助手继续
                                   │
                  ⑥ 汇总 ──▶ 主动发给你
```

### 七个助手

| id | 名称 | 职责 | 模型 | 沙箱 |
|---|---|---|---|---|
| `task` | 任务助手 | 识别任务、拆解子任务、指派角色，产出 `PLAN.json` | `xiaomi/mimo-v2.6` | workspace-write |
| `code` | 代码助手 | 代码审查、查 bug、执行命令、构建、部署 | `deepseek-v4-flash` | **danger-full-access** |
| `vision` | 视觉助手 | 图片直读 + 视频直读 | `xiaomi/mimo-v2.6-flash` | workspace-write |
| `file` | 文件助手 | Word/PPT/PDF/Excel 内容提取与结构化 | `xiaomi/mimo-v2.6-flash` | workspace-write |
| `audio` | 语音助手 | 语音转写的整理与理解 | `xiaomi/mimo-v2.6-flash`（转写明用直连 `mimo-v2.5-asr`） | workspace-write |
| `research` | 科研助手 | 科研问题分析、文献检索、成果综述 | `xiaomi/mimo-v2.6-pro` | workspace-write |
| `search` | 搜索助手 | 全网资料检索与可追溯汇总 | `deepseek-v4-flash` | workspace-write |

改分工：编辑 `config.json`（首次运行 `byk run` 后自动生成），或直接改 `byk/config.py` 里的 `DEFAULT_ROLES`。用 `python -m byk roles` 看当前生效值。

### 关于模型路由的两个事实

> 模型分工现状：`task`/`code`/`search` 跟随峰谷（高峰 `xiaomi/mimo-v2.6-flash`、低谷 `deepseek-official/deepseek-flash`）；
> `research` 固定 `xiaomi/mimo-v2.6-pro`（全局禁用名单里，靠角色级白名单放行）；`vision`/`file` = `xiaomi/mimo-v2.6-flash`；
> `audio` = 直连 `mimo-v2.5-asr` 转写、再交 `mimo-v2.6-flash` 整理。

**1. 视觉助手能真读图和视频，靠的就是 `mimo-v2.6`。** 这条路由声明了 `[text, image]` 输入，DSH 的 `read_image` 工具**只在所选模型声明 image 输入时才可用**，已用会话日志确证它实际调用了 `read_image` 并收到真实图片块。**视频**走另一条路（DSH 没有视频通路）：由编排器把整段视频直调小米接口交给同款模型观看，画面与音轨一起读。换回纯文本模型会立刻退化为 OCR 兜底。

**2. 路由整体失效时会自动回退，并且一定会被标注。** 密钥失效（401）、余额耗尽（429/402）这类失败与任务本身无关，但**如果中招的恰好是任务助手，整条流程会连规划都做不出来**。所以 `run_agent` 在识别到路由级失败时会换兜底路由重试一次，并在子任务状态里写明"原本想用 x / 实际用了 y / 原因"。绝不静默降级。

兜底路由默认是 `deepseek-official / deepseek-v4-flash`，可在 `config.json` 改 `fallback_provider` / `fallback_model`。

> 实测记录：`xiaomi` 曾返回 401（用户更换密钥后恢复）；`zai` 返回 429 余额不足；`minimax-cn` 返回 402 余额不足。后两条至今不可用。

---

## 2. 关键设计决策

### 2.1 为什么每个助手是独立的 DSH 进程

`dsh --profile headless "<任务>"` 会启动一个完整的 DSH 智能体：拥有该部署的全部工具（shell、文件读写、代码检索、`web_search`、`read_image`），跑完把结果打到 stdout，然后退出。

好处：

- **真实工具权限**。代码助手能真的执行命令、读写文件，不是"假装在操作"。
- **零额外密钥**。它复用桌面端 `DSH_HOME` 里已配好的凭据（`dsh-credentials-local` 逐层解析：进程环境 → `.credentials.yml` → 项目 `.env` → 用户 `.env`）。
- **上下文隔离**。一个助手跑偏了不会污染其他助手。
- **可分别配模型与人格**。通过 `--patch` 覆盖层按 id 定向改配置。

### 2.2 长任务说明走文件，不走命令行

Windows 命令行上限约 32KB，而 PDF 提取出的正文轻易超过它。所以：

1. 编排器把完整任务说明写入 `<job_dir>/TASK.md`；
2. 命令行只传一句短引导语；
3. 助手用 `read` 工具自己读；
4. 产出入 `<job_dir>/RESULT.md`，需要结构化输出时入 `PLAN.json`。

### 2.3 提权为什么收归编排器

**无头子进程无法自行提权**——DSH 的提权需要审批应答者，无头模式没有，会直接 fail closed（这一点我实测确认过）。

因此设计成：

1. 代码助手的人格里写死**绝不自行政权**（不许 sudo / RunAs / 改系统服务）；
2. 需要提权时它把请求写进 `<job_dir>/PRIVILEGE_REQUEST.json`（理由、确切命令、预期效果、先例关键词、风险级别）；
3. 编排器读取请求 → 匹配先例库 → **在界面上弹确认给你**；
4. 你点批准后才执行，执行输出写回 `PRIVILEGE_RESULTS.md`；
5. **重新唤起该助手**，让它读到真实结果后继续后续步骤。

这样"记住先例"和"每次都要你点确认"两件事同时成立，而且助手不会在你不知情时动系统。

### 2.4 先例库永不存明文口令

先例记录只放 `secret_ref`（如 `PRECEDENT_ROOT_PW_SRV1`），真值在 `data/secrets.json`（已在 `.gitignore` 里）。命令模板里用 `{{secret}}` 占位，给用户看的预览永远是掩码，执行输出回写前也会把密钥擦成 `••••••••`。

如果命令里有 `{{secret}}` 却没匹配到任何绑定了密钥的先例，确认弹层会**显式警告"即使批准也无法执行"**并把风险等级提升为 `high`，同时允许你在批准时直接指定密钥引用 —— 而不是让你点了批准却什么都没发生。

### 2.5 子任务之间的产物交接

每个子任务有**自己独立的工作目录**，这是上下文隔离的基础。但"构建 → 部署"这类链路要求下游拿得到上游的文件，所以编排器会：

- 把 `depends_on` 里每个前置子任务产出的文件，复制到下游目录的 `from_<子任务id>/` 下（保留目录结构，单次交接上限 200MB）；
- 在 `TASK.md` 的「上游交接过来的文件」小节里明确列出，并提醒助手**不要去翻别的子任务目录**；
- 同时仍把前置子任务的 `RESULT.md` 摘要内嵌进 `TASK.md`，让下游既知道结论、也拿得到文件。

上游的 `TASK.md` 不会被复制（避免下游误当成自己的任务说明）。

---

## 3. 安装与启动

```powershell
cd C:\Projects\byk

# 1) 创建虚拟环境并装齐依赖（编排核心 + 提取层，共用一个 .venv）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install -r requirements-extract.txt

# 2) 启动服务与界面（必须用 .venv 的 python，否则提取层会因缺库而全部失败）
.\.venv\Scripts\python.exe -m byk serve
# 打开 http://127.0.0.1:8760
```

> **为什么必须用 `.venv` 的 python**：提取层（pypdf / python-pptx / rapidocr / faster-whisper）
> 装在项目虚拟环境里，而编排器是**同进程**导入它的。用系统 python 启动会导致
> 所有附件提取返回"缺库"，而不是报错崩溃。命令行工具同理：
> `.\.venv\Scripts\python.exe -m byk run "..."`。

前置条件（本机已满足，已实测）：

| 依赖 | 用途 | 本机位置 |
|---|---|---|
| DSH 运行时 | 每个助手的执行引擎 | `C:\coding\DSH Desktop\runtime\harness\` |
| `headless` profile | 无头智能体组合 | `%APPDATA%\com.yeagoo.dsh-desktop\harness\profiles\headless\` |
| Node.js | 拉起助手进程 | `C:\coding\Nodejs\node.exe` |
| ffmpeg | 视频抽帧与音轨 | `C:\utils\ffmpeg\bin\ffmpeg.exe` |
| Python 3.11 | 编排器与提取层 | `C:\coding\Python\python.exe` |

> `headless` profile 是本系统新建的（原来只有 `web` profile）。它是一个 30 行的目录：
> `package.json` 声明 `bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`，
> 外加空的 `cordis.yml` 与 `cordis.patch.yml`。

---

## 4. 用法

### 4.1 界面

浏览器打开后，直接输入文字、拖入文件，回车发送。流程是：

1. 界面显示提取进度（每个附件一个结果块）；
2. 任务助手产出计划 → **计划确认卡片**出现，你可以改派角色、改标题说明，然后点「确认执行」；
3. 子任务卡片按依赖顺序并发执行，实时显示状态与输出；
4. 遇到提权需求 → 弹确认层，显示匹配到的先例和确切命令；
5. 全部完成后汇总卡片出现。

### 4.2 命令行

```powershell
# 跑一个回合（会交互式问你确认计划和提权）
python -m byk run "把这个项目部署到 10.0.0.5 的 8080 端口，源码在 deploy.zip 里"

# 自动确认（脚本化；请确认你清楚它在干什么）
python -m byk run "…" --yes

# 查看角色与模型分工
python -m byk roles

# 录入提权密钥
python -m byk secret set PRECEDENT_ROOT_PW_SRV1

# 查看/手工添加先例
python -m byk precedent list
python -m byk precedent add --title "重启 8080 服务" --command "ssh root@10.0.0.5 'systemctl restart app'" --keywords "重启,服务,8080"
```

### 4.3 部署场景的完整走法

你发一句「把 `deploy.zip` 里的项目部署到 10.0.0.5:8080」并附上压缩包和一个 README：

1. 编排器本地提取 README 正文与压缩包清单 → `EXTRACT.md`；
2. 任务助手据此产出计划，例如：
   - `st_1` 审查代码质量与依赖 → `code`
   - `st_2` 部署到目标主机并启动 → `code`（`depends_on: [st_1]`，`needs_privilege: true`）
   - `st_3` 读 README 提炼部署注意事项 → `file`
3. 计划回给你确认；
4. `st_1`、`st_3` 并发跑；`st_1` 通过后 `st_2` 开始；
5. `st_2` 中途发现要杀旧进程需要 root，上交 `PRIVILEGE_REQUEST.json`；
6. 编排器匹配到历史先例、弹出确认、你批准后以 root 执行、写回结果、重新唤起代码助手收尾；
7. 汇总主动发给你。

---

## 5. 当前能力与限制（诚实说明）

我实测确认过下面每一条，不是推测。

### ✅ 已确证可用

- 无头 DSH 智能体启动、认证、执行命令、读写文件。
- `--patch` 覆盖人格与模型（实测人格覆盖生效）。
- `web_search` 工具在无头模式下可用 → 搜索助手与科研助手的检索能力成立。
- 代码助手能真的执行 shell（实测创建并读回文件）。
- **视觉助手能直读原图**（`mimo-v2.6` 路由，有会话日志证据：实际调用 `read_image` 并收到图片块）。
- **视觉助手能直读视频**（编排器直调小米接口，画面文字/画面内容/音频/时间轴一起读出；实测有效）。
- 文件/图片/音频的**本地**提取（不依赖任何模型）。
- 子任务按依赖分层并发；上游产物能交接给下游。
- 提权请求会被拦截、经用户确认后才由编排器执行，成功后沉淀为先例。
- 每个回合的真实 token 用量会被自动计入汇总。

### ⚠️ 需要你知道的现实

**1. 路由可用性（2026-09-20 实测）。**

| 路由 | 实测结果 |
|---|---|
| `deepseek-official` | ✅ 可用 |
| `xiaomi` | ✅ 可用（曾返回 401，更换密钥后恢复） |
| `zai` | ❌ 429 余额不足 |
| `minimax-cn` | ❌ 402 余额不足 |

`deepseek` 全部模型都是**纯文本**；只有 `mimo-v2.6` / `mimo-v2-omni` 声明了图片输入。所以视觉助手用 `mimo-v2.6` 不是随便挑的。

**2. 视频可以真正"直接交给大模型"——但这需要绕开 DSH 的管线。**

我一开始的判断是错的。当时我看的是 pi-ai 的**模型目录元数据**（`mimo-v2.6` 标为 `input: ['text','image']`），据此断言"没有任何模型支持视频"。**目录声明不等于模型能力**——实测小米的 OpenAI 兼容接口接受

```json
{"type": "video_url", "video_url": {"url": "data:video/mp4;base64,..."}}
```

并且 `mimo-v2.6` 能同时读出**画面文字、画面内容、音频语音与时间轴**。

问题是 **DSH 没有视频通路**（实测：`'video'` 在 pi-ai 里出现 0 次；`dsh-tool-fs`/`dsh-attachment`/`dsh-llm` 各 0 次；附件服务只收图片；`read_image` 只认 PNG/JPEG/WebP/GIF）。所以由**编排器直接调提供商接口**，见 `byk/video_ai.py`：把整段视频交给模型观看，得到的描述写进 `EXTRACT.md`，视觉助手据此作答。

两条路径的结果对比（同一个测试视频）：

| 维度 | 模型直接看视频 | 本地 ffmpeg 抽帧 + whisper |
|---|---|---|
| 画面文字 | `BYK VIDEO OCR 2024`（空格正确） | `BYKVIDEO OCR2024`（空格丢失） |
| 画面内容 | 彩条测试卡、圆环、底部渐变条、逐秒计数器 | **完全没有** |
| 音频 | 逐句转写 | 逐句转写 |
| 时间轴 | 画面与语音按秒对应 | 仅帧时间戳 |

**两条路径都保留**：抽帧 OCR + 音轨转写作为**交叉校验**（实测有效——助手据此发现了 OCR 丢空格、以及 whisper 少识别了一个 "Hello"）。关掉直读可设 `config.json` 的 `direct_video: false`。

> 代价：视频直读是一次**额外的模型请求**，按视频体积与时长计费，且大视频 base64 后体积涨约 1/3（`byk/video_ai.py` 里设了 96MB 源文件上限）。


**3. 图片直读已可用（此前的限制已解除）。**

DSH 的 `read_image` 工具**仅当所选路由的模型声明 `image` 输入时才工作**。切到 `xiaomi/mimo-v2.6` 后视觉助手已能直读原图，并有日志证据：该会话实际调用了 `read_image` 并收到真实图片块，产出里能描述**字体形态**这类 OCR 文本里不存在的信息。

保底机制仍在：若图像路由再次不可用（改回纯文本模型、或密钥/余额出问题），视觉助手会自动退回"OCR 文本 + 逐像素分析"路线，并**明确标注**"本结论基于 OCR 文本，非直接观察图像"。


**4. 无头助手是"一次性"的。**

`dsh --profile headless` 跑完一个任务就退出，且**最终答案只在结束时一次性输出**，没有逐 token 流式。所以界面上子任务卡片是"运行中（计时）→ 一次性出现完整产出"，而不是逐字打字机效果。这是 DSH 无头模式的固有行为，不是本系统没做。

**5. 提取层的边界（实测确认）。**

| 情况 | 行为 |
|---|---|
| `.doc` / `.ppt` / `.xls`（97-2003 老格式）、`.7z` / `.rar` / `.tar.gz` | 不支持，返回 `unknown` + 明确错误 |
| **扫描件 PDF**（无文字层） | **不做 OCR**，返回 `ok=True` 但正文为空，并在 `meta.has_text_layer=false` 中说明。需要先转成图片再提取 |
| 时长 > 120 秒的视频 | 只 OCR **前 120 秒**（抽帧上限 24 帧），并置 `meta.frames_truncated=true` |
| 空文件 | 一律判为失败（这是刻意的：空文件没有可提取内容） |
| OCR 空格 | rapidocr 会丢空格（`BYK VIDEO OCR 2024` → `BYKVIDEO OCR2024`），逐行原文与置信度保留在 `meta.lines` |
| 首次语音转写 | 需联网下载 whisper 权重（约 538MB，缓存在 `data/models/whisper`） |
| 中文/英文 OCR | 都可用，模型随 wheel 分发，**不需要联网** |

**6. 服务必须用 `.venv` 的 python 启动**，原因见第 3 节。用系统 python 不会崩，但所有附件提取都会返回"缺库"。

### 5.1 成本：这件事必须提前知道

助手的**每一步（含每次工具调用）都是一次真实的模型请求、真实计费**。一个"看起来只问了一句"的回合，可能变成几十次模型请求和上百次检索。

我实测过一次（6 个端到端回合、21 个助手会话）：

| 项目 | 数量 |
|---|---|
| 模型请求 | 202 次 |
| 输入 token | 203,904 |
| 缓存命中 token | 4,315,392 |
| 输出 token | 153,272（其中推理 73,593） |
| **`web_search` 独立服务端请求** | **213 次** |

两个容易踩的坑：

1. **`web_search` 是单独的模型请求、单独计费。** 搜索/科研助手若不加约束会反复检索（我那次科研回合跑出上百次）。所以两个角色的人格里有硬性"单任务不超过 6 轮检索"的约束。
2. **曾经吃过亏：`deepseek-v4-pro` 在长链路里会被极度放大。** 我最初把 4 个角色都配了它，其中一个科研回合就占了全部开销的近一半。**现在它已被列入禁用名单，代码层面封死。**

**当前分工：所有用到 deepseek 的地方一律用 `deepseek-v4-flash`**，其余角色按第 1 节的表。要换就改 `config.json` 或 `byk/config.py: DEFAULT_ROLES`（但禁用名单里的模型设不进去）：

```powershell
$p = ".\.venv\Scripts\python.exe"
& $p -m byk roles          # 查看当前生效的分工
```

**换成 mimo 之后的实测对比**（同一类任务："一张图 + 一段语音"，同样的输入文件）：

| 配置 | 子任务 | 模型请求 | 输入 | 输出 | 其中推理 |
|---|---|---|---|---|---|
| 旧：`vision`=deepseek-pro、`audio`=deepseek-flash、`task`=deepseek-pro | 2 | 24 | 23,531 | **14,529** | 6,572 |
| 新：`vision`/`audio`=mimo-v2.6、`task`=mimo-v2.6 | **3** | 23 | 32,534 | **6,717** | 0 |

新配置**多做了一个子任务**（多一步整合），输出却只有旧配置的约 46%；代价是输入涨了约 38%（mimo-v2.6 读得更细）。输出通常比输入贵，所以大概率更省，但**具体金额取决于你的实际单价，我不替你算**。

这是单次观测，不是普遍规律——**自己用下面的命令量你真实的场景**。

**随时查真实用量**（读自 DSH 会话日志的 `assistant/message.usage`，是实际发生值，不是估算）：

```powershell
$p = ".\.venv\Scripts\python.exe"
& $p -m byk usage                      # 全部助手会话的汇总 + 按模型拆分
& $p -m byk usage --turn t_3ea5842f4a  # 某个回合花了多少
& $p -m byk usage --all                # 连你自己的人工会话一起算
```

每个回合完成后，**汇总末尾会自动附上该回合的真实用量**（含按模型拆分与检索次数），所以不用另开窗口也知道花了多少。HTTP 上对应 `GET /api/usage?turn_id=…`。

底层工具是 `tools/usage_report.js`，也可以单独跑（人类可读或 `--json`）。它靠会话目录名里编码的 cwd 区分来源——助手进程的工作目录是 `data/jobs/<回合>/<子任务>`，所以能把开销精确归到某一步。

---

## 6. 目录结构

```
C:\Projects\byk\
├── byk/                    编排核心（Python 包）
│   ├── orchestrator.py     回合状态机：提取→规划→确认→派发→提权→汇总
│   ├── dsh_runner.py       把一次助手调用落地为无头 DSH 进程
│   ├── video_ai.py         把视频直调小米接口交给模型观看（DSH 无视频通路，故绕开）
│   ├── usage.py            读取 DSH 会话日志里的真实 token 用量
│   ├── roles.py            七个助手的人格定义、模型分工、能力可用性
│   ├── precedents.py       提权先例库 + 本地密钥库 + 特权命令执行
│   ├── server.py           FastAPI：REST + SSE + 静态前端
│   ├── cli.py              命令行工具
│   ├── models.py           数据模型（与契约严格一致）
│   ├── bus.py              进程内事件总线（推给 SSE）
│   └── extract/            本地内容提取层（文档/图片/音频/视频/压缩包）
├── web/                    跨平台前端（纯静态，无构建步骤）
├── docs/
│   ├── api-contract.md     接口契约（唯一事实来源）
│   ├── extract-report.md   提取层实测报告
│   └── ui-notes.md         前端说明
├── tests/
│   ├── e2e_smoke.py        端到端验收（真实拉起助手）
│   └── test_extract.py     提取层测试
├── tools/
│   ├── usage_report.js     从 DSH 会话日志统计真实 token 用量
│   └── probe_xiaomi_video.py  独立探测小米接口是否接受视频（判定能力用，不改任何状态）
├── data/                   运行时数据（已被 .gitignore 排除）
│   ├── jobs/<回合>/<子任务>/   每个助手的 TASK.md / RESULT.md / 产出
│   ├── uploads/            你上传的原始文件
│   ├── secrets.json        密钥真值（绝不入先例库）
│   └── precedents.json     提权先例
└── config.json             角色模型分工等本机配置（自动生成）
```

---

## 7. 测试

全部用 `.venv` 的 python 跑。

```powershell
$p = ".\.venv\Scripts\python.exe"

# 提权先例库、密钥掩码、依赖分层（29 项断言）
& $p tests\test_precedents.py

# 提权往返流程：批准 / 拒绝 / 密钥未绑定 三个场景（39 项断言，隔离运行，不动真实系统）
& $p tests\test_privilege_flow.py

# HTTP 契约：参数校验、错误码、密钥不回显、SSE 收尾（30 项断言）
& $p tests\test_api.py

# 子任务间产物交接：上游产物确实交给下游（11 项断言）
& $p tests\test_artifact_handoff.py

# 模型路由失效时的回退行为与配置隔离（18 项断言）
& $p tests\test_route_fallback.py

# 视频直读模块：错误处理、请求格式、响应解析（18 项断言，全用桩）
& $p tests\test_video_ai.py

# 提取层（36 项，素材现场生成）
& $p -m pytest tests\test_extract.py -v

# 端到端验收：真实拉起助手进程，耗时数分钟并消耗额度
# ⚠ 这些会真实花钱：一轮通常几十次模型请求 + 多次检索。
#   建议先只跑纯文本那条，确认链路没问题后再按需要跑其余。
& $p tests\e2e_smoke.py                                                    # 纯文本，走 search 角色
& $p tests\e2e_smoke.py "解读附件的文档与压缩包" tests\_fixtures\sample.docx tests\_fixtures\sample.zip   # 走 file 角色
& $p tests\e2e_smoke.py "创建并运行脚本，把输出落盘再读回"      # 走 code 角色（用 pro，最贵）
& $p tests\e2e_smoke.py "分别告诉我图片上的文字和语音里说了什么" tests\_fixtures\chinese.png tests\_fixtures\speech.wav  # 走 vision + audio，且并发
```

> 前面四个测试文件（`test_precedents` / `test_privilege_flow` / `test_api` / `test_artifact_handoff` / `test_extract`）
> **完全不花钱**：它们全部用桩或本地解析，不拉起任何助手进程、不调用任何模型。日常改动后跑这些就够了。

端到端脚本会自己起服务、建回合、订阅 SSE、自动确认计划与提权，最后对以下不变量断言：
回合到达 `completed`、计划已生成、至少一个子任务成功、汇总非空、经历过 `awaiting_confirmation`
阶段、SSE 收到 `done`；带附件时还会断言全部附件提取成功且至少一个产出非空文本。

| 测试 | 覆盖 | 断言数 |
|---|---|---|
| `test_precedents.py` | 先例匹配/累加、密钥永不入库、命令掩码、依赖分层与成环 | 29 |
| `test_privilege_flow.py` | 提权批准→执行→回写→续跑；拒绝不执行；密钥未绑定则拦截 | 39 |
| `test_api.py` | HTTP 契约、错误码、密钥不回显、已结束回合 SSE 收尾 | 30 |
| `test_artifact_handoff.py` | 上游产物交接（含嵌套目录、TASK.md 不误复制） | 11 |
| `test_route_fallback.py` | 401/429 触发回退并标注；任务级失败不回退；配置实例互不干扰 | 18 |
| `test_video_ai.py` | 视频直读：六类失败优雅返回、请求格式、reasoning_content 兜底、密钥不入请求体 | 18 |
| `test_extract.py` | 各类文件提取 + 9 项缺库降级 + 6 项垃圾输入 | 36 |
| `e2e_smoke.py` | 真实全链路：纯文本 / 带文档附件 / 代码执行 / 图片+语音 / 视频 | 6 / 9 / 6 / 9 / 9 |

> 合计 **181 项**不花钱的断言。日常改动后跑这些就够了。
| `e2e_smoke.py` | 真实全链路 | 见下表 |

### 七个角色的端到端验证矩阵

下表全部来自**真实跑通的回合**（不是设计意图）：

| 角色 | 验证方式 | 结果 |
|---|---|---|
| `task` | 每次回合都由它规划，多次产出合法 `PLAN.json` | ✅ |
| `code` | 创建脚本 → 真实执行 → 输出落盘 → 读回并做字节级校验 | ✅ |
| `file` | 解析 docx 与 zip；发现 `EXTRACT.md` 只列了压缩包清单后**自行解包**读成员正文 | ✅ |
| `vision` | `mimo-v2.6` 直读原图（日志确证调用 `read_image`，并描述了字体形态）；**视频**由编排器直调小米接口交给同模型观看，产出含画面文字/画面内容/音频/时间轴，并与抽帧 OCR 交叉校验（发现了 OCR 丢空格） | ✅ |
| `audio` | whisper 转写正确；用 ffprobe + WAV 头 + RMS 能量包络交叉验证，并声明估计值非模型时间戳 | ✅ |
| `search` | 真实调用 `web_search`，产出带来源链接与检索局限的结论 | ✅ |
| `research` | 已跑通完整回合（检索 → 归纳 → 核查引用），产出带链接与不确定项 | ✅ |


---

## 8. 想扩展时改哪里

| 想做的事 | 改哪里 |
|---|---|
| 换某个助手的模型 | `config.json` 或 `byk/config.py: DEFAULT_ROLES` |
| 改助手的人格/纪律 | `byk/roles.py` 里对应的 `*_PERSONA` |
| 加一个新助手角色 | `byk/roles.py` 的 `ROLES` 字典 + `DEFAULT_ROLES`，前端配色加一项 |
| 换搜索/科研的检索来源 | 各角色人格里关于 `web_search` 的段落；或挂 MCP 工具 |
| 让视觉助手直读原图 | 补一个可用的图像模型密钥，改 `byk/roles.py: IMAGE_ROUTES` 里的 `usable` |
| 换视频理解所用的模型 / 关掉视频直读 | `config.json` 的 `video_model` / `direct_video` |
| 确认某个提供商接口是否真支持视频 | `python tools\probe_xiaomi_video.py`（只发探测请求，不改状态） |
| 改提权策略 | `byk/orchestrator.py: _handle_privilege` 与 `byk/precedents.py` |
| 改界面 | `web/`（纯静态，改完刷新即可，无需构建） |
