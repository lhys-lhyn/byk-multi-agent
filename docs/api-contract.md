# BYK 多智能体系统 — 接口契约 v1

本文件是**唯一事实来源**。所有模块必须严格按此契约实现，不得自行更改字段名、事件名或角色 id。

## 0. 术语与总体结构

- **主对话（orchestrator）**：用户唯一交互对象。由 `byk/` 编排核心实现（确定性代码 + LLM 汇总），**不是一个被拉起的智能体**。
- **7 个助手（specialist agents）**：每个都是一次独立的 DSH 无头智能体进程。
- 角色 id 固定为以下 7 个，不得增删改名：

| role id | 名称 | 职责 |
|---|---|---|
| `task` | 任务助手 | 识别文本中的任务、拆成子任务、指派角色，产出结构化计划 |
| `code` | 代码助手 | 代码审查、查 bug、执行命令、部署、计算机相关一切 |
| `vision` | 视觉助手 | 图片/视频内容理解 |
| `file` | 文件助手 | Word/PPT/PDF 等文件内容提取 |
| `audio` | 语音助手 | 语音转文字并理解 |
| `research` | 科研助手 | 科研问题、文献检索、研究思路 |
| `search` | 搜索助手 | 一切与问题相关的资料检索 |

## 1. 助手进程调用方式（已实测可用）

```
node "C:\coding\DSH Desktop\runtime\harness\node_modules\@deepseek-ai\dsh\lib\bin.js" \
     --profile headless --patch <patch.yml> "<短引导语>"
```

- 无头进程使用与桌面端相同的 `DSH_HOME`，凭据自动解析，无需 API key。
- 工作目录＝调用时的 cwd，即该子任务的 job 目录。
- stdout 输出最后一条非空 assistant 文本；成功退出码 0。

**长文本绝不走命令行参数**（Windows 命令行上限约 32KB）。约定：
1. 编排器把完整任务说明写入 `<job_dir>/TASK.md`；
2. 命令行只传短引导语：`你的完整任务说明在 <job_dir>\TASK.md。请先用 read 工具完整读取它，然后严格执行，并把最终结果写入 <job_dir>\RESULT.md。`
3. 需要结构化输出的角色，要求其把 JSON 写入 `<job_dir>/PLAN.json`。

`--patch` 覆盖层用于按角色注入人格与模型（已实测生效）：

```yaml
- id: system-prompt
  config:
    persona: >-
      <该角色的人格文本>
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

## 2. 已确证的运行环境事实（不要再猜）

> ⚠️ 本节若干条目已随后续实测更新，**以 `README.md` 为准**。这里保留原始记录以便对照。
> 最关键的两条变化：`xiaomi` 密钥修好后已可用；视频由编排器直调接口已可读。

- 可用模型路由**只有** `deepseek-official`：`deepseek-v4-flash`（纯文本）。
  **`deepseek-v4-pro` 已被用户列入禁令**（`byk/config.py: forbidden_models`），代码层面封死。
- `zai`＝429 余额不足；`minimax-cn`＝402 余额不足；`xiaomi`＝401 密钥无效。均不可用。
- **任何 provider 都不支持视频输入**。图片输入只有 `xiaomi/mimo-v2-omni`、`xiaomi/mimo-v2.6`、`zai/glm-5v-turbo`、`minimax-cn/MiniMax-M3` 声明支持，而它们当前都不可用。
- DSH 的 `read_image` 工具**仅当所选路由模型声明 `image` 输入时才可用**。
- `web_search` 工具在无头模式下实测可用。
- 无头子进程**无法自行提权**（无审批应答者，直接 fail closed）。因此**特权操作一律由编排器执行**，不交给助手。
- 本机：Windows，PowerShell 5.1，`python`＝3.11.9（`C:\coding\Python\python.exe`），`node`＝v24.13.0，ffmpeg＝`C:\utils\ffmpeg\bin\ffmpeg.exe`，无 tesseract，PyPI 可达。

## 3. Python 数据模型

```python
from dataclasses import dataclass, field
from typing import Any, Literal

ExtractKind = Literal["document", "image", "audio", "video", "archive", "text", "unknown"]

@dataclass
class ExtractionResult:
    path: str                 # 绝对路径
    name: str                 # 原始文件名
    kind: ExtractKind
    ok: bool
    text: str = ""            # 提取出的文本内容，可能为空串
    meta: dict = field(default_factory=dict)
    error: str | None = None
    method: str = ""          # "pypdf" | "python-pptx" | "whisper:small" | "ocr:rapidocr" | "passthrough" ...

@dataclass
class SubTask:
    id: str                   # "st_1", "st_2" ...
    title: str
    detail: str               # 要做什么 + 验收标准
    role: str                 # 7 个 role id 之一
    depends_on: list[str] = field(default_factory=list)
    inputs: list[str] = field(default_factory=list)   # 附件 id 或路径
    needs_privilege: bool = False
    acceptance: str = ""

@dataclass
class TaskPlan:
    goal: str
    subtasks: list[SubTask]
    assumptions: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)

@dataclass
class SubTaskState:
    id: str
    title: str
    role: str
    detail: str
    status: Literal["pending","running","succeeded","failed","skipped","blocked"] = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    duration_s: float | None = None
    output: str = ""
    log_tail: str = ""
    error: str | None = None
    artifacts: list[dict] = field(default_factory=list)

@dataclass
class AgentResult:
    role: str
    ok: bool
    output: str
    exit_code: int
    duration_s: float
    stdout: str = ""
    stderr: str = ""
    error: str | None = None
    job_dir: str = ""
```

## 4. 提取层接口（`byk/extract`）

```python
def detect_kind(path: str) -> ExtractKind: ...
def extract_file(path: str, *, ocr_lang: str = "ch", whisper_model: str = "small") -> ExtractionResult: ...
def extract_many(paths: list[str], **kw) -> list[ExtractionResult]: ...
```

要求：

- **文档**：`.pdf`→pypdf；`.docx`→python-docx；`.pptx`→python-pptx（**必须逐页提取，含表格与备注**）；`.xlsx/.xlsm`→openpyxl；`.txt/.md/.csv/.json/.log/.yaml/.xml`→直读（按编码探测）；`.rtf`→尽力。
- **图片**：本地 OCR（推荐 `rapidocr-onnxruntime`，纯 CPU、无需 torch），返回 `text` + `meta`（宽高、格式、字节数）。**不得调用任何 LLM。**
- **音频**：`faster-whisper` 本地转写，`text` 为转写全文，`meta` 含 `duration_s`、`language`、`segments`（`[{start,end,text}]`）。
- **视频**：ffmpeg 抽帧（默认每 5 秒 1 帧，上限 24 帧）逐帧 OCR，按时间戳拼接为 `[t=12.5s] <文字>`；同时抽取音轨走 whisper 转写。`meta` 含 `duration_s`、`width`、`height`、`fps`、`sampled_frames`、`has_audio`、`transcript_segments`。
- **压缩包**：`.zip` 只列出成员清单（名称/大小/是否目录）写入 `meta["members"]`，**不递归解包**。
- **所有可选依赖必须惰性导入**：缺库时返回 `ok=False` 且 `error` 写明"缺哪个库、装什么"，**绝不允许抛异常炸掉编排器**。
- 单个文件处理失败不得影响其他文件。
- 单文件提取文本上限 200KB，超出截断并在 `meta["truncated"]=True`。

## 5. HTTP / SSE 契约（`byk/server.py`，FastAPI）

静态前端由同一个服务挂载在 `/`，文件位于 `web/`。

### REST

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{"ok":true,"version":"1"}` |
| GET | `/api/roles` | — | `[{"id","name","model","description","available":bool,"note":str}]` |
| POST | `/api/turns` | `multipart/form-data`：`text`(str)、`files`(file[], 可空)、`session_id`(str, 可空) | `{"session_id","turn_id"}` |
| GET | `/api/turns/{turn_id}` | — | 完整 turn 快照（见下） |
| POST | `/api/turns/{turn_id}/confirm` | `{"approved":bool,"plan":TaskPlan|null}` | `{"ok":true}` |
| POST | `/api/turns/{turn_id}/cancel` | — | `{"ok":true}` |
| POST | `/api/confirmations/{cid}` | `{"approved":bool,"remember":bool}` | `{"ok":true}` |
| GET | `/api/precedents` | — | `[Precedent]` |
| GET | `/api/usage?turn_id=…` | — | 真实 token 用量；带 `turn_id` 查单回合，不带则汇总全部助手会话 |
| GET | `/api/events?turn_id=...` | — | SSE 流 |

### turn 快照 JSON

```json
{
  "turn_id": "t_xxx",
  "session_id": "s_xxx",
  "created_at": "ISO8601",
  "user_text": "……",
  "attachments": [{"id":"a1","name":"doc.pdf","kind":"document","size":12345,"path":"…"}],
  "stage": "intake|extracting|planning|awaiting_confirmation|executing|summarizing|completed|failed|cancelled",
  "extractions": [ExtractionResult…],
  "plan": TaskPlan | null,
  "subtasks": [SubTaskState…],
  "summary": "……" | null,
  "error": null,
  "pending_confirmation": Confirmation | null
}
```

### SSE 事件

每帧格式 `event: <name>\ndata: <json>\n\n`。事件名与负载固定如下：

| event | data |
|---|---|
| `snapshot` | 完整 turn 快照（连接建立时先发一次） |
| `stage` | `{"turn_id","stage"}` |
| `extraction` | `{"turn_id","extraction":ExtractionResult}` |
| `plan` | `{"turn_id","plan":TaskPlan}` |
| `subtask` | `{"turn_id","subtask":SubTaskState}` |
| `agent_delta` | `{"turn_id","subtask_id","stream":"stdout"\|"stderr","text"}` |
| `confirmation` | `{"turn_id","confirmation":Confirmation}` |
| `summary` | `{"turn_id","summary":"…"}` |
| `error` | `{"turn_id","message":"…"}` |
| `done` | `{"turn_id","stage":"completed"\|"failed"\|"cancelled"}` |

### Confirmation（提权确认）

```json
{
  "id": "c_xxx",
  "kind": "privilege",
  "title": "以 root 身份结束占用 8080 端口的旧进程",
  "reason": "匹配到历史成功先例（已成功 3 次）",
  "precedent_id": "p_xxx",
  "command_preview": "sudo -S systemctl stop byk-old",
  "secret_source": "密钥来自本地密钥库 PRECEDENT_ROOT_PW_SRV1（不回显明文）",
  "risk": "medium",
  "requires_secret": false,
  "secret_ref": "PRECEDENT_ROOT_PW_SRV1",
  "turn_id": "t_xxx",
  "subtask_id": "st_2"
}
```

**`requires_secret` 必须被前端显式呈现。** 当它为 `true` 时，说明命令里含 `{{secret}}` 占位符却**没有匹配到任何已绑定的密钥引用** —— 此时即使用户点「批准」也无法执行。前端必须：

- 把该确认标为高风险（后端此时也已把 `risk` 提升为 `high`）；
- 在弹层里醒目展示 `secret_source` 中的警告文案；
- **允许用户在批准时通过输入框补充密钥引用**，并随批准一起提交：

```json
POST /api/confirmations/{cid}
{ "approved": true, "remember": false, "secret_ref": "PRECEDENT_ROOT_PW_SRV1" }
```

`secret_ref` 为可选字段；省略或为 `null` 时沿用后端匹配到先例所绑定的引用。

### Precedent（提权先例）

```json
{
  "id": "p_xxx",
  "title": "……",
  "match_keywords": ["杀进程","重启","端口占用"],
  "command_template": "……",
  "secret_ref": "PRECEDENT_ROOT_PW_SRV1",
  "success_count": 3,
  "last_used_at": "ISO8601",
  "created_at": "ISO8601"
}
```

**先例库与密钥库永不存明文口令**：`secret_ref` 只作引用，真值放在 `data/secrets.json`（加入 .gitignore）。

## 6. 前端要求（`web/`）

- 纯静态：`index.html` + `app.js` + `styles.css`，**无构建步骤**，原生 ES module，可直接被 FastAPI `StaticFiles` 托管。
- 中文界面。深色主题，桌面优先，窄屏可用。
- 必须实现：
  1. 输入区：多行文本 + 拖拽/选择文件（可见附件 chips）+ 发送。
  2. 回合时间线：用户输入块 → 各阶段进度 → 计划卡片 → 子任务卡片 → 汇总卡片。
  3. **计划确认卡片**：展示 `plan.goal`、`assumptions`、`questions`，每个子任务可**改派角色**（下拉，选项来自 `/api/roles`）与**编辑标题/说明**；有「确认执行」与「取消」按钮。这是用户明确要求的确认环节。
  4. 子任务卡片：角色徽标、状态色（pending/running/succeeded/failed/skipped/blocked）、耗时、可折叠的实时输出（`agent_delta` 追加）、完成后显示 `output`。
  5. 提权确认弹层：展示 `title`/`reason`/`command_preview`/`risk`，「批准」与「拒绝」。
  6. 错误与 SSE 断线重连（`EventSource` 自动重连即可，重连后拉一次 `/api/turns/{id}` 对齐状态）。
- 角色徽标配色：task=紫，code=蓝，vision=青，file=琥珀，audio=粉，research=绿，search=橙。
