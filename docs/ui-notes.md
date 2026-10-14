# BYK 前端（`web/`）说明与验证记录

本文件记录三件事：**文件结构**、**mock 模式怎么用**、**我实际验证到了什么程度（以及哪些没验证）**。
实现依据只有 `docs/api-contract.md` 第 5 节（HTTP/SSE 契约）与第 6 节（前端要求），路径名、事件名、字段名一字未改。

---

## 1. 文件结构

纯静态、无构建步骤、原生 ES module，可被 FastAPI `StaticFiles` 直接挂载在 `/`。

```
web/
├── index.html                 页面骨架（顶栏 / 三栏 / 弹层与 toast 容器）
├── styles.css                 深色主题全部样式（含角色徽标色与状态色变量、窄屏媒体查询）
├── app.js                     入口：装配 store/后端/视图，SSE 生命周期、重连对齐、全局动作
├── js/
│   ├── util.js                极简 DOM 构建器 + 时间/大小格式化 + 契约枚举标签 + 阶段推断
│   ├── roles.js               契约 §0 的 7 个角色兜底表；与 GET /api/roles 合并
│   ├── store.js               唯一状态源：turn 快照 + SSE 事件按 id 幂等归并
│   ├── api.js                 HttpBackend（真实 FastAPI）与后端选择、URL 参数解析
│   ├── mock-backend.js        MockBackend：接口与 HttpBackend 完全一致，事件由脚本回放
│   └── ui/
│       ├── timeline.js        时间线装配：块的顺序、复用、清理
│       ├── blocks.js          用户输入块 / 提取结果块 / 阶段进度 / 汇总 / 错误 / 等待占位
│       ├── plan-card.js       计划确认卡片（改派角色 + 编辑标题说明 + 确认/取消）
│       ├── subtask-card.js    子任务卡片（状态色、耗时、可折叠实时输出与最终输出）
│       ├── confirm-modal.js   提权确认弹层（批准/拒绝、记住、requires_secret 告警 + 补填密钥引用）
│       ├── composer.js        输入区（多行文本 + 拖拽/选择文件 + 附件 chips + 发送）
│       ├── leftrail.js        左栏：角色花名册 + 会话/回合列表
│       ├── inspector.js       右栏：当前回合阶段与子任务状态总览 + 状态色图例 + 先例库
│       └── toast.js           右下角提示
└── mock/                      mock 数据与回放脚本（仅 ?mock=1 时加载）
    ├── turn.json              符合契约的 turn 快照（含 3 个 attachment）
    ├── plan.json              TaskPlan（4 个子任务：st_1 只读、st_2/st_3 需提权、st_4 检索）
    ├── confirmation.json      Confirmation ×2 —— 两种样本：
    │                          c_mock_01 requires_secret=false（密钥引用已由先例绑定，risk=medium）
    │                          c_mock_02 requires_secret=true （{{secret}} 未绑定引用，risk=high）
    ├── precedents.json        [Precedent] ×3
    ├── extractions.json       [ExtractionResult] ×3（含一个 ok=false 的失败样例）
    ├── roles.json             GET /api/roles 的等价返回
    ├── turns.json             左栏"会话/回合"列表用的历史回合
    └── replay.js              事件序列脚本（buildReplay），供 mock-backend 定时投递
```

设计要点：

- **幂等渲染**。所有块按 key 复用（`user` / `extract` / `stage` / `plan` / `st:<id>` / `summary` / `error`），
  子任务、提取结果按 id 更新；`agent_delta` 的流式文本写在 `<pre>` 里是"把权威文本写进去"而不是追加字符串，
  因此重连重放快照不会重复渲染，也不会把同一段输出显示两遍。
- **计划卡片保护用户输入**。计划内容未变化时不重建行；用户改过（dirty）时远端快照绝不覆盖输入；
  一旦进入执行阶段（或已确认/取消）即锁定为只读。
- **状态单调**。快照/事件都不允许把子任务状态从 succeeded/failed/skipped/blocked 退回 pending/running，
  也不允许阶段倒退，避免陈旧快照导致界面闪烁回退。
- **不做阻塞式对话框**。全程不用 `alert/confirm`，错误与确认都走 toast 与页面内弹层。
- **无图片输入依赖**。界面只用文字与 CSS 动画（running 状态脉冲），不引用任何外部资源，离线可用。

### 自查：`requires_secret` 到底实现在哪里

这个字段**不在** `web/` 顶层的三个文件里（`index.html` / `styles.css` / `app.js` 只出现 `secretRef`
与 `.confirm-warning` 等间接引用），只做**非递归**搜索会得出"没实现"的错误结论。
递归搜一次即可看到全部落点：

```powershell
Select-String -Path (Get-ChildItem C:\Projects\byk\web -Recurse -File).FullName -Pattern requires_secret
```

应有 22 处命中，分布在 7 个文件：

| 文件 | 作用 |
|---|---|
| `web/js/ui/confirm-modal.js` | 读 `c.requires_secret`，渲染告警条 / 输入框 / 徽标，批准时取输入框的值 |
| `web/js/util.js` | `confirmationBody()`：唯一的请求体构造函数（决定 `secret_ref` 是否出现） |
| `web/js/api.js` | `HttpBackend.confirmPrivilege(cid, approved, remember, secretRef)` 用它发请求 |
| `web/app.js` | `actions.decideConfirmation(..., secretRef)` 透传 |
| `web/js/mock-backend.js` | 用同一构造函数记录"收到的提交体"；锚点别名；fail-closed 分支 |
| `web/js/ui/subtask-card.js` | 依据 `subtask_id` + `requires_secret` 给子任务卡片标「等待密钥引用」 |
| `web/mock/confirmation.json` | 两个样本（`false` / `true`）；`web/mock/replay.js` 与 `plan.json` 驱动两种弹层 |

---

## 2. mock 模式怎么用

```
# 直接打开本地文件不行（file:// 会拦截 ES module 与 fetch），必须经 http
python -m http.server 8317 --directory C:\Projects\byk\web        # 或 npx --yes serve web
# 浏览器打开
http://127.0.0.1:8317/index.html?mock=1
```

后端托管时同一地址下的 `/index.html?mock=1` 效果相同（mock 数据按 `new URL('../mock/*.json', import.meta.url)` 取）。

URL 参数：

| 参数 | 作用 |
|---|---|
| `?mock=1` | 不连任何后端、不发任何请求；角色/先例/回合列表/事件全部来自 `web/mock/` |
| `&speed=fast` \| `slow` | 回放速度倍率（默认正常，动画约 18–20 秒走完） |
| `&at=<锚点>` | 快进到某个锚点并**冻结**（截图/自检用），锚点见下 |
| `?turn_id=<id>` | 实时模式的深链：直接打开某个回合（只调 `GET /api/turns/{id}`） |

锚点（`&at=`）：`extracting` → `plan`（计划卡片可编辑）→ `running`（子任务 1 流式输出中）
→ `running-st2`（子任务 2 的 stderr 流）→ `privilege`（**已绑定密钥**的提权弹层，`requires_secret=false`）
→ **`privilege-need-secret`（`requires_secret=true` 的缺密钥告警弹层，冻结在这一刻便于截图核对）**
→ `done`（全部完成）。

> `privilege-need-secret` 是**规范锚点名**；同时保留短别名 `privilege-secret`、`need-secret`、`secret`
> （`js/mock-backend.js` 的 `ANCHOR_ALIAS` 统一映射到同一个冻结点），两个名字都验证过能到达同一弹层。

`?mock=1` 不带 `at` 时是完整动画，且在**三个闸门**处**停下来等真人操作**：
计划卡片点「确认执行」→ 第一个提权弹层点「批准」→ 第二个（缺密钥）提权弹层补填引用后点「批准」。
回放覆盖的完整链路：
`连接→提取→规划→计划确认→st_1 流式输出→st_2 提权(已绑定密钥)→批准→st_2 succeeded→`
`st_3 提权(requires_secret=true，缺密钥)→批准(可补填引用)→st_3 succeeded/受阻→st_4 检索→汇总→done`。

五个不同的收尾分支都可以在 mock 里手动走到（这是有意的，用于验证 fail-closed 语义）：

| 你的操作 | 结果 |
|---|---|
| 第二个弹层补填引用后批准 | st_3 成功；汇总里写出实际使用的引用名；右栏显示带上 `secret_ref` 的提交体 |
| 第二个弹层**留空**就批准 | st_3 受阻：`命令含 {{secret}} 占位符但没有可用密钥引用（requires_secret=true），未执行`；st_4 跳过；回合 failed；右栏提交体**不含** `secret_ref` 键 |
| 第二个弹层点「拒绝」 | st_2 已成功（端口已修），st_3 受阻（用户拒绝）、st_4 跳过 |
| 第一个弹层点「拒绝」 | st_2 受阻、st_3/st_4 跳过（什么都没执行） |
| 计划卡片点「取消回合」 | 回合 cancelled |

`?mock=1` 下输入区也能用：拖文件、打字、发送会创建一个新的演示回合并重放同一段脚本
（附件不会真的上传，也不会落盘）。

---

## 3. 我实际验证到了什么

**验证手段**（都在本机真实运行，不是"我觉得没问题"）：

1. 本地静态服务器（Python `http.server`，端口 8317）托管 `web/`。
2. 无头 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）+ CDP 驱动脚本：
   21 个场景逐一导航、真实点击、截图，并对页面做**结构化布局审计**与**像素级配色统计**，
   末尾汇总 **22 条断言**（`docs/ui-shots/verify-report.json` 的 `checks` 字段）。
3. 语法层面：`node --check` 对 16 个 JS 文件全部通过。

> 说明：本会话所用模型 `deepseek-v4-flash` 不声明图像输入，`read_image` 直接报错
> （`model "deepseek-v4-flash" does not declare image input`），因此**我无法用眼睛看这些 PNG**。
> 为不谎报验证结果，我改用下面两类可复现的客观证据替代目视：
> ① CDP 在真实渲染后读取每个元素的 `getBoundingClientRect`/计算样式做断言；
> ② 在 Chrome 画布里解码 PNG，统计亮度、深色占比、墨迹占比与关键配色像素数，
> 并生成 ASCII 密度图（我据此"看"过布局骨架，也据此排除过空白/错位）。
> 这两项能覆盖错位、溢出、裁切、重叠、配色、元素缺失/多余，但**不能替代人眼对审美的最终确认**。

### 结果（21 个场景 / 22 条断言全部通过；`docs/ui-shots/` 下 21 张截图 + 1 份审计原始数据）

每个场景都断言：无未捕获异常、无 console 错误、无 `#fatal-root` 错误条、
无横向溢出（`scrollWidth == innerWidth`）、时间线各块**按顺序单调排列且互不重叠**、
无可视元素越出视口左右边界、无"设了 overflow:hidden 又装不下"的文字裁切、输入区可见。

| 截图 | 阶段 | 这一张确认了什么 |
|---|---|---|
| `01-plan-confirm.png` | 冻结在 `plan` | 时间线顺序：用户输入 → 提取结果(3 个文件) → 阶段进度 → 计划卡片 → 4 张子任务卡片；计划卡片显示 goal/4 条 assumptions/2 个 questions，4 行子任务各自的角色下拉（7 个选项）、标题框、说明框、依赖/输入/验收/需提权标签；「确认执行」「取消回合」可用，「撤销编辑」禁用（未改过） |
| `02-plan-edited.png` | 同上，改派+编辑后 | st_2 角色改成 `research` 后徽标立刻变绿、st_1 标题与 st_3 说明被改写，「撤销编辑」变为可用，出现"已修改，尚未确认"提示 |
| `03-subtask-running.png` | 冻结在 `running` | st_1 蓝色"运行中"（脉冲）、输出区自动展开并持续追加（443 字符、已贴底）、其余 3 张灰色待执行；像素统计中蓝色像素 2403（其余场景基线 ~200），绿色仍在基线 → 运行态确实是蓝色而非绿色 |
| `12-st2-stderr-running.png` | 冻结在 `running-st2` | st_1 绿"已完成"显示**最终输出**且流式区被清空（不重复显示），st_2 运行中出现 `stdout/stderr` 两个页签且**自动切到有内容的 stderr**（stderr 黄色告警文本已渲染） |
| `04-privilege-modal.png` | 冻结在 `privilege`（`requires_secret=false`） | 第一个提权弹层：`提权确认` 标签、标题、原因、风险徽标（中风险/medium）、`需要密钥 = 已绑定`、`密钥引用 = PRECEDENT_ROOT_PW_SRV1`、匹配先例 p_1、命令预览、密钥来源说明、"记住此决定"、"拒绝/批准"；弹层完整在视口内；**没有告警块、没有密钥输入框**；像素统计里红色 `#ef4444` 计数为 0（未进入命中列表） |
| **`21-need-secret-modal.png`** | 冻结在 **`at=privilege-need-secret`**（`requires_secret=true`） | **缺密钥告警态（规范锚点名）**：弹层顶部多出「缺密钥引用」徽标、风险自动显示为**高风险**、醒目红色告警块（⚠ + `secret_source` 原文 + 补充说明）、`需要密钥 = 缺密钥引用（requires_secret=true）`、`密钥引用 = —`、`匹配先例 = —`、以及标签为「补充密钥引用（可选）」的**密钥引用输入框**（placeholder 给出示例引用名）；焦点默认落在「拒绝」上 |
| `17-privilege-secret-modal.png` | 冻结在别名锚点 `at=privilege-secret` | 同上的状态，用于证明**两个锚点名都指向同一弹层** |
| `05-modal-after-confirm.png` | 真实点击「确认执行」后 | 走完整交互链路时弹层同样出现（不是只在冻结模式下能出现）；此时计划卡片已被改派过（见 §4 第 1 条之外的说明） |
| **`18-secret-modal-in-flow.png`** | 交互流程中（批准完第一个弹层后） | 第二个（缺密钥）弹层在**真实点击流程**里也会出现，红色像素同为 549；时间线上 st_3 卡片同时出现「等待密钥引用」标记（由 `pending_confirmation.subtask_id` + `requires_secret` 推导） |
| `06-completed.png` | 在第二个弹层**补填引用后**批准 | 4 个子任务全部绿色"已完成"（st_3 有 396 字最终输出）；汇总里写出本次实际使用的密钥引用；右栏统计 4/4、阶段步进走到"已完成"；像素统计绿色 5027（基线 205） |
| **`19-secret-missing-blocked.png`** | 在第二个弹层**留空**就批准 | 后端 fail-closed 语义在界面上成立：st_3 橙色"受阻"、错误文案为 `命令含 {{secret}} 占位符但没有可用密钥引用（requires_secret=true），未执行口令轮换`，st_4 黄色"已跳过"，汇总给出补救办法；像素统计橙色 1660、黄色 1084 |
| **`20-secret-gate-rejected.png`** | 在第二个弹层点「拒绝」 | 分支正确：st_2 已成功（端口已修）、st_3 受阻（用户拒绝）、st_4 跳过，汇总说明服务仍在用旧口令运行 |
| `10-rejected-blocked.png` | 在**第一个**弹层点「拒绝」 | 分支正确：st_2 橙色"受阻"带错误说明、st_3/st_4 黄色"已跳过"、汇总改写为"你拒绝了提权…"，阶段步进在"执行中"标红；像素统计橙色 1837、黄色 1925（基线 ~200/~130）→ blocked/skipped 配色确实生效 |
| `11-cancelled.png` | 真实点击「取消回合」 | 回合结束于 cancelled，计划卡片锁定为"已取消"，阶段步进停在"等待确认"并标红 |
| `13-composer-attachments.png` | 拖拽两个文件后 | 拖拽 `dragover` 高亮生效、两个附件 chip 显示文件名与类型/大小（文本 · 7 B、文档 · 14 B）、文本已填入 |
| `14-new-turn.png` | 点击「发送」后 | 新回合确实创建：左栏回合数 3→4 且新回合被选中，时间线用户输入块显示新文本与两个附件 chip，输入框被清空，计划卡片为该新回合渲染 |
| `07-narrow-760.png` | 760px 宽 | 单栏：主对话（时间线+吸底输入区）在最前，侧栏顺次下移；无横向溢出、无重叠、无裁切 |
| `09-narrow-480-modal.png` | 480px 宽 + 弹层 | 480px 下弹层宽 440、完整在视口内（t=235/b=965），按钮均可点，无横向溢出 |
| `08-extracting.png` | 冻结在 `extracting` | 提取阶段的占位块文案、提取结果块"等待提取"、阶段步进停在"提取中" |
| `15-no-backend.png` | 实时模式指向不存在的回合（无后端） | 容错：健康检查/角色/先例请求失败只弹 toast 不崩；SSE 报 `事件流已断开`（EventSource 收到 404 后关闭）；界面显示空态与提示，**没有虚构的"错误"卡片**（见下） |

`docs/ui-shots/verify-report.json` 是上面每个场景的完整审计原始数据（含每个块的矩形、
计划卡片每行的角色/标签/禁用状态、子任务每张卡的状态/配色/输出长度/滚动位置、
弹层字段、右栏统计、截图字节数、console 与异常列表），可用于复核。

### 与真实后端（`byk/server.py`）的集成检查

我做完 mock 验证后 `byk/server.py` 已经就位，于是又用真后端跑了一遍交付路径
（`python -m uvicorn byk.server:app --port 8399`，只读静态与 GET 接口，**没有创建任何真实回合**，
所以不会拉起 DSH 子进程）：

| 检查 | 结果 |
|---|---|
| `GET /`（`StaticFiles(html=True)` 挂载在 `/`） | 200，返回 `web/index.html` → 前端确实由后端根路径托管 |
| `.js` 的 MIME | `application/javascript`（本机 Windows 未出现 `.js` 被当成 `text/plain` 导致 ES module 拒载的常见坑） |
| `.json` / `.css` | `application/json` / `text/css; charset=utf-8` |
| `GET /api/health` | `{"ok":true,"version":"1"}` → 顶栏显示"服务正常 · version 1" |
| `GET /api/roles` | 真实返回 7 个角色，前端正确渲染名称/模型/可用性/说明 |
| `GET /api/precedents` | 真实返回 `[]` → 右栏显示空态"暂无先例"，不报错 |
| 同源下 `?mock=1&at=plan` | 正常回放（mock JSON 与 `mock/replay.js` 都能从 `/mock/...` 取到） |
| `GET /api/turns/t_not_exist`（不存在）与 `/api/events?turn_id=...` 的 404 | 前端弹出"拉取回合快照失败：…HTTP 404：回合不存在"与"事件流已断开"，**不产生虚构的错误卡片**，界面不崩 |
| `_sse()` 的 `event: X\ndata: {...}\n\n` 帧格式与 `: keep-alive` 心跳注释行 | 与前端命名监听器兼容（心跳是注释行，不会被当成 `error` 事件；此处为读代码确认，未跑真实回合） |
| `POST /api/confirmations/{cid}` 的**实际请求体**（CDP 抓包） | 见下：`secret_ref` 有值才出现，留空则整个字段不出现 |

`secret_ref` 的线上格式（在页面里直接 `import('/js/api.js')` 调 `HttpBackend.confirmPrivilege`，
cid 故意用不存在的值 → 后端 404、无副作用，同时用 CDP 抓真实请求体）：

```
带引用       → {"approved":true,"remember":false,"secret_ref":"REF_ONE"}
空字符串     → {"approved":true,"remember":false}
undefined    → {"approved":true,"remember":false}
只有空格     → {"approved":true,"remember":false}
null         → {"approved":true,"remember":false}
```

即"用户没填就不提交该字段"，与契约 §5 的"省略或为 null 时沿用后端匹配到先例所绑定的引用"一致。

截图 `16-served-by-fastapi-mock.png` 就是"由 FastAPI 托管 + mock 回放"的那一张（现在含 4 个子任务）。

### 请求体专项断言（`secret_ref` 到底有没有随批准提交）

这一条的难点是：mock 模式下**没有任何 HTTP 请求**，所以"点批准"不会产生可抓的包。用了两条互补的证据链：

1. **点批准 → mock 后端记录到的提交体**（用户建议的方式）。请求体由**唯一的**构造函数产出
   （`js/util.js` 的 `confirmationBody()`），`HttpBackend` 用它发真正出去的包、`MockBackend`
   用它记录"如果发出去会是什么"，因此断言这个记录等价于断言线上格式。
   记录结果同时**渲染到右栏**（`.submit-line`：`mock 已收到确认提交：{...}`），
   所以截图里就能直接核对，无需翻报告：
   - 输入框填 `PRECEDENT_SVC_ACCOUNT_PW` 后点「批准」 → `{"approved":true,"remember":false,"secret_ref":"PRECEDENT_SVC_ACCOUNT_PW"}`（与契约示例同构）
   - 留空直接点「批准」 → `{"approved":true,"remember":false}`（**`secret_ref` 键整个不出现**，符合"省略即沿用先例绑定引用"）
2. **对真实 FastAPI 后端 CDP 抓包**（`Network.requestWillBeSent`）：确认同一个构造函数产出的
   请求体在线上就是第 1 条那两种形状（cid 用不存在的值，后端 404、无副作用、不拉起任何 DSH 子进程）：

```
带引用   → {"approved":true,"remember":false,"secret_ref":"REF_ONE"}
空串 / undefined / 纯空格 / null → {"approved":true,"remember":false}
```

**没断言到的部分**：没有用"真后端 + 真实回合"跑过端到端点击（那需要真的创建一个回合，
会拉起 4 个 DSH 助手进程、消耗额度），所以"前端点批准 → 真后端 200"这一整条链**未被端到端验证**，
验证到的是"点击产生的 body 形状正确" + "该形状在真后端上确实是这个格式"。

### 验证中发现并修掉的问题（都是真实缺陷，不是"看起来还行"）

1. **提权弹层批准后抛未捕获异常**。`decide()` 在 `await` 之后仍引用弹层内部状态，
   而 store 清空 `pending_confirmation` 会触发 `sync → close()` 把该状态置空 →
   `TypeError: Cannot read properties of null (reading 'busyEl')`，界面出现红色错误条。
   修法：进入 `decide` 时先把 turnId/cid/按钮等引用抓到局部变量，catch 分支再判空。
2. **`EventSource` 自带的 `error` 事件被当成契约里的 `error` SSE 事件**（两者同名）。
   后果：任何一次断线都会凭空冒出一条"未知错误"回合错误卡片。修法：
   命名监听器里先判断 `ev instanceof MessageEvent` 且有 `data`，否则忽略。
   （这条正是"无后端"场景 15 抓出来的。）
3. **终态（failed/cancelled）时阶段步进全灭**。`STAGE_ORDER.indexOf('failed') === -1`，
   导致右栏 7 个步骤全是待办。修法：新增 `resolveStageIndex()` 按已知进度推断停在
   "等待确认"还是"执行中"，并在该步标红；取消未执行时停在"等待确认"，提权被拒时停在"执行中"。
4. **stderr 增量看不见**。默认页签是 stdout，当 stdout 为空而 stderr 有内容时输出区一片空白。
   修法：另一条流有内容时自动切换页签（用户手动点过页签后不再自动切换）。
5. **窄屏输入区被挤到屏幕外**。单栏时左栏在最前，输入框要滚很久才能看到。
   修法：单栏下把主对话（时间线+输入区）排到最前，并让输入区 `position:sticky` 吸底
   （760px/480px 下实测输入区始终贴住视口底部）。
6. **mock 自动模式（`&at=`）通过提权闸门后弹层残留**。自动模式没有真人点击，
   弹层不会被关掉，会盖在后续截图上（我一度以为 12 号截图偏暗是别的原因，
   像素统计的亮度差暴露了它）。修法：自动通过闸门后补发一次快照让界面收掉弹层；
   而 `at=privilege` / `at=privilege-secret` 仍冻结在"弹层显示中"这一刻。
7. **（新增第二个提权闸门时暴露）闸门之后的步骤漏打分支标记**。`mock/replay.js` 里
   `deltas()` 生成的 `agent_delta` 步骤、以及第二个 `confirmation` 事件与第二个 `gate` 步骤
   当初没有 `branch` 字段，于是"拒绝第一个提权"之后，回放虽然跳过了 `branch:'approved'` 的
   子任务/汇总步骤，却仍然继续产流并弹出了第二个确认弹层 → 界面卡在弹层上、汇总永不出现
   （这正是 `reject-privilege` 场景从"通过"变成"超时"的原因）。修法：给 `deltas()` 增加
   `branch` 选项，并给第二个 confirmation/gate 补上 `branch:'approved'`；另外写了一个打印
   "闸门 1 之后是否仍有未标分支的 step"的自检脚本，逐个确认过。
   现在四个分支（拒绝闸门 1 / 拒绝闸门 2 / 批准但缺密钥 / 全批准）都会走到各自的汇总。

此外还处理了两处工程细节：验证时给 CDP 关掉 HTTP 缓存（否则可能拿到改代码前的旧 JS，
会得出错误结论——上面第 6 条一度就出现过这种假象）；`node --check` 覆盖全部 16 个 JS 文件。

---

## 4. 已知不足与不确定之处

**契约层面我拿不准、但按字面实现的地方**（后端若与此不同，需要改前端）：

1. **契约没有"列出所有回合"的接口**（只有 `GET /api/turns/{turn_id}` 和 `POST /api/turns`）。
   因此实时模式下左栏"会话/回合"列表只包含**本次页面打开后创建/深链过的回合**，
   刷新页面就没了。mock 模式用 `web/mock/turns.json` 造了 2 个历史回合来演示列表形态。
   若后端愿意，加一个 `GET /api/turns?session_id=` 就能填满这个列表。
2. **`stage` 的取值里没有"失败发生在哪一步"的信息**。`failed` 只告诉结果，
   所以阶段步进的红色位置是按"已规划→执行中"推断的，可能与真实失败点不一致。
3. **`done` 事件的 `stage` 与快照里的 `stage`** 我按"done 覆盖 stage"处理；
   若后端在 `done` 之后又发一个更早阶段的 `stage` 事件，前端会忽略（状态单调保护）。
4. **`pending_confirmation.kind` 只见过 `privilege`**。弹层对未知 kind 也会渲染，
   标题显示为"确认（<kind>）"，但没有针对其它类型的专用字段布局。
5. **`requires_secret` / `secret_ref`（新增字段）我按字面实现**：为 `true` 时弹层顶部出现
   红色告警块（正文取 `secret_source`）、头部加「缺密钥引用」徽标、`需要密钥` 一行显示
   `缺密钥引用（requires_secret=true）`、并显示一个可选的密钥引用输入框；批准时只在用户
   填了内容才把这个值放进 `secret_ref` 提交（留空则整个键不出现，与契约"省略或为 null 时沿用
   先例绑定引用"一致）。有两点需要你确认：
   - 契约说 `risk` 此时已被后端提升为 `high`，我**直接显示后端给的值**（不自己改写）；
     若后端偶尔漏改，界面会显示中风险但仍有告警块（告警块是主要信号，不依赖 risk）。
   - 用户留空仍允许点「批准」（按"可选字段"语义），此时界面会补一条黄色 toast
     提示"很可能无法执行"。如果你希望前端**硬拦**（留空时禁用批准按钮），告诉我改一行即可。
6. **Confirmation 里的 `turn_id` / `subtask_id` 也被我用上了**：`turn_id` 作为弹层"所属回合"
   的首选来源（缺失时回退到当前回合），`subtask_id` 用来在时间线上给对应子任务卡片标
   「等待提权确认」/「等待密钥引用」。
5. **确认接口没有"我改了计划但角色不可用"的服务端校验**。前端只做非空与"角色 id 属于契约 7 个"
   的本地校验，并在选中不可用角色时给黄色提示后照样提交，由后端决定跳过还是失败。
6. **`agent_delta` 没有序号/offset 字段**，因此断线重连期间丢失的增量无法补齐——
   前端只能在重连拉快照时用 `output` 覆盖；若后端在子任务运行中就给 `output` 赋值，
   实时流会被最终值替换（当前实现是"有 output 就显示 output 并清掉流缓冲"）。
7. **`SubTaskState` 里没有 `needs_privilege`/`depends_on`/`acceptance`**，
   这三个信息只在 `TaskPlan` 里。前端从 `plan.subtasks` 按 id 反查；
   若后端只发 `subtask` 事件而计划已被清空，卡片上的这些标签会消失。
8. **`GET /api/roles` 实际还返回一个 `color` 字段**（例如 `task=#a78bfa`、`code=#60a5fa`、`vision=#22d3ee`），
   契约 §5 的响应字段表里没有它。我**没有用它**，而是严格按契约 §6 末列的映射
   （task 紫 #a855f7 / code 蓝 #3b82f6 / vision 青 #06b6d4 / file 琥珀 #f59e0b /
   audio 粉 #ec4899 / research 绿 #22c55e / search 橙 #f97316）上色——两者色相一致、明度不同。
   如果希望以后端返回的 `color` 为准，改一处即可（`roles.js` 的 `mergeRoles` + 徽标的内联 `--role-c`）。
9. 后端还提供了契约里没有的 `/api/config`（含 `max_parallel`、`allow_privileged`、各角色
   `sandbox`/`timeout_s`/`enabled`）与 `/api/secrets`（只列引用名）。前端当前**没有**使用它们，
   但如果要展示"某角色被禁用/沙箱模式"之类的信息，这些字段是现成的。

**实现上已知的不足**：

- **我本人没有用眼睛看过任何一张截图**（本会话模型不支持图像输入，`read_image` 报错）。
  我只做了上面第 3 节的机器断言 + 像素统计 + ASCII 密度图。因此
  "没有错位/溢出/重叠/裁切/元素缺失"这类结构性结论是有依据的，
  但**配色观感、字号疏密、视觉层次是否好看，未经过人眼确认**，需要你或能看图的模型复核一次。
- 时间线不支持"虚拟滚动"，子任务很多（>50）或输出极长时 DOM 会变大。
  流式缓冲按单流 200KB 截断（保留尾部）。
- `agent_delta` 的渲染是"每次更新重写 `<pre>` 文本"，超长输出下会有 O(n) 重排；
  演示与常见规模没问题，极长日志场景建议后端控制 `text` 分片大小。
- 输出区自动滚动采用"贴底才跟随"（离底 24px 内视为贴底），用户往上滚即暂停跟随；
  这一点没有做显式的"回到底部"按钮。
- 断线重连依赖 `EventSource` 自动重连 + `open` 后主动 `GET /api/turns/{id}` 对齐；
  若服务端返回非 `text/event-stream`（例如 404/500），`EventSource` 会永久关闭，
  此时顶栏显示"事件流已断开"，需要点「重连事件流」手动恢复（没有做指数退避的自动重试）。
- 附件上传限制、大小校验、进度条都没有做（契约里 `POST /api/turns` 是同步返回 turn_id）。
- 密钥引用输入框是**普通文本框**，只做 `trim()`，不校验引用名格式，也不会去 `GET /api/secrets`
  拉候选列表做下拉（那个接口不在契约 §5 里，用了就是额外依赖）；因此用户填错引用名时，
  失败信息只能来自后端（例如命令执行报"密钥引用不存在"）。
- 输入框里显式写了"只填引用名，不要填明文口令"——前端**不会**、也不应该请求或存储口令明文。
- mock 的自动模式（`&at=done`）在"需要密钥"的闸门处会用一个**占位引用名**
  `PRECEDENT_SVC_ACCOUNT_PW` 模拟"用户照提示填了"，这样终态是全部成功；
  留空导致的 fail-closed 分支由交互场景（`19-secret-missing-blocked.png`）单独覆盖。
  真人走 `?mock=1` 时不会被自动填充，弹层里输入框是空的。
- 弹层的"记住此决定"（`remember`）在 mock 里只是记录下来，没有持久化先例的效果。
- 实时模式的 `?turn_id=` 深链只用于打开单个回合，不做浏览器历史/路由（无 pushState）。
- `GET /api/precedents` 只在右栏做展示与弹层内反查，未提供先例的编辑/删除入口（契约里也没有对应接口）。
