# dsh-plugin 版本与回退手册

> 快照与回退工具目录：C:\Projects\byk\dsh-plugin-releases\
> 插件目录：C:\Projects\byk\dsh-plugin

## 版本表

| 版本 | 位置 | 状态 | 说明 |
|---|---|---|---|
| v1.1.0-baseline | `C:\Projects\byk\dsh-plugin-releases\v1.1.0-baseline` | 已冻结（**回退目标**） | 升级前现状快照，2026-10-04 生成，16 个文件 + MANIFEST.json；git `b1f0668` |
| v1.2.0 | `C:\Projects\byk\dsh-plugin-releases\v1.2.0` | **已发布（当前版本）** | 2026-10-04 生成，16 个文件 + MANIFEST.json（fileCount=16）；git `16a7419`；过程结论见 `v1.2.0-notes.md` |

git 基线：插件目录已初始化为 git 仓库。本机 git 在 `C:\coding\Git\cmd\git.exe`（git version 2.32.0.windows.2，
与 `C:\coding\Nodejs\`、`C:\coding\DSH\` 同层；任务书最初列的 6 个候选路径全部不存在）。

| 版本 | git commit | 说明 |
|---|---|---|
| v1.1.0-baseline | `b1f06680117960113753a52260852311242c82a9`（master，root-commit，15 个文件） | 升级前状态 |
| v1.2.0 | `16a7419`（`feat: v1.2.0 — subagentTools 配置 + 客户端审批镜像模块 + readme 收口`，5 files changed, 545 insertions(+), 15 deletions(-)） | 当前 HEAD |

提交身份用 `-c user.name` / `-c user.email` **局部**指定，未改全局 git 配置。
建议打 tag（**尚未执行**）：`git -C C:\Projects\byk\dsh-plugin tag v1.1.0-baseline b1f0668`、
`git -C C:\Projects\byk\dsh-plugin tag v1.2.0 16a7419`

---

## 一、回退命令（可直接复制执行）

### 0. 通用用法（已实测：不带参数 → 打印用法，退出码 2）

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs
```

输出（实测原文）：`ERROR: missing <snapshotDir>. usage: node rollback.mjs <snapshotDir> [--root <pluginDir>]`

完整用法（见 `rollback.mjs:4-11`）：

```
node rollback.mjs <snapshotDir> [--root <pluginDir>] [--backup-root <dir>] [--manifest <file>] [--prune] [--dry-run]
```

### 1. 回退到 v1.1.0-baseline

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.1.0-baseline
```

行为：① 先把插件目录中除 node_modules 外的全部内容备份到 C:\Projects\byk\dsh-plugin-releases\pre-rollback-<时间戳>\；
② 用快照内容覆盖回去（node_modules 不动）；③ 逐文件 sha256 与 MANIFEST.json 比对并打印一致/不一致清单。
退出码：0 = 全部一致；1 = 有不一致或缺失；2 = 参数错误。

### 2. 先看清楚会发生什么（不写盘）

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.1.0-baseline --dry-run
```

### 3. 连新版本新增的文件一起清掉（真正的回到旧版）

默认只覆盖、不删除；v1.2.0 新增的文件会作为 EXTRA 列出来。要连它们一起删：

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.1.0-baseline --prune
```

--prune 只删「快照里没有、目标里存在」的文件，且始终保护 node_modules 与 .git。

### 4. 回退错了，从兜底备份再救回来

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\pre-rollback-<时间戳>
```

即把 pre-rollback-<时间戳> 目录当快照用（它没有 MANIFEST.json，需配合 --manifest 指定或先补一份）。

### 5. git 路线（本机 git 可用，更省事）

```powershell
git -C C:\Projects\byk\dsh-plugin status
git -C C:\Projects\byk\dsh-plugin checkout -- .
git -C C:\Projects\byk\dsh-plugin reset --hard b1f06680117960113753a52260852311242c82a9
```

---

## 二、本次回退能力基线（验收数字）

- 源目录文件数（排除 node_modules）：58
- 其中 .git 内部文件：42
- 其中插件自身文件（排除 node_modules 与 .git）：16
- 快照 MANIFEST.json 条目数：16

说明：MANIFEST 收录的是「插件自身文件」。.git 是版本库工作状态，纳入快照会让 sha256 比对产生
无意义漂移（index、logs 等会变），因此快照排除 .git 并在 MANIFEST 的 excluded 字段注明：
excluded = ["node_modules", ".git"]。需要连 git 状态一起回退时用第一节第 5 条。

### 1b. 回退到 v1.2.0（与 1 同形，只换快照目录）

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.2.0
```

已实测的 `--dry-run`（退出码 **0**，16/16 sha256 一致）：

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.2.0 --dry-run
```

注意：dry-run 会就插件目录里的 `.git/` 报 50 条 EXTRA——那是版本库自身的工作状态，**不是异常**；
真正的回退不动 `.git`（`--prune` 也始终保护 `node_modules` 与 `.git`）。

---

## 三、以后发布新版本时要做的

1. 改代码前，先确认要被回退到的那个快照（当前是 v1.2.0 或 v1.1.0-baseline）与对应 commit 都在。
2. 改完并验证后，生成新快照。`make-snapshot.mjs` 已随 `.byk-work` 清理删除，重建方式：
   按 `v1.2.0\MANIFEST.json` 的结构写一个 20 行的复制+sha256 脚本，或直接照 v1.1.0 时期的做法
   （`excluded = ["node_modules", ".git"]`、`{version, createdAt, excluded, fileCount, files:[{relPath,bytes,sha256}]}`）。
3. 在新版本目录里跑一次 `rollback.mjs <新快照> --dry-run`，确认 `consistent: N / N`、退出码 0。
4. 回退用第一节命令。

## 四、已知边界（重要）

- rollback.mjs 不复制也不校验 node_modules（依赖目录/junction，回退时保持不动）。
- 快照不含 .git，原因见第二节。
- 默认不删除多余文件（防误删）；要彻底还原旧版请加 --prune。
- 回退前先停掉正在加载该插件的 DSH 进程，否则文件被占用可能复制失败。

## 五、演练结论

演练日志（原件 `.byk-work\rollback-drill.log` 已随 v1.2.0 收口清理，结论保留于此）：

- 正例：备份 17 个文件 → 覆盖 16 个文件 → sha256 **16/16 一致**，退出码 **0**。
- 反例：故意篡改 1 个文件后 dry-run → 检出 1 处 SHA256 不一致，退出码 **1**。
- 缺快照参数 → 打印用法，退出码 **2**。
- 演练全部在 `.byk-work\drill\` 的复制品上进行，**未触碰真实插件目录**。

---

## 六、v1.2.0 本轮实际执行记录（2026-10-04）

| 动作 | 命令 | 结果 |
|---|---|---|
| 生成快照 | `node make-snapshot.mjs C:\Projects\byk\dsh-plugin C:\Projects\byk\dsh-plugin-releases\v1.2.0 v1.2.0` | `files copied: 16`，退出码 **0** |
| 提交 | `git -C C:\Projects\byk\dsh-plugin -c user.name=… -c user.email=… commit -m "feat: v1.2.0 …"` | `16a7419`，5 files changed；`git status --porcelain` 为空 |
| 快照自检 | `node rollback.mjs …\v1.2.0 --dry-run` | `consistent: 16 / 16`，退出码 **0** |
| 用法自检 | `node rollback.mjs`（无参数） | 打印用法，退出码 **2** |
| 语法自检 | `node --check lib\{asr,client,index,plan,routing,timing}.js` | 6/6 退出码 **0** |
| 回归 | `node test/plan.test.js` / `node test/timing.test.js` / `node test/run-smoke.mjs` | 全 **0**（「计划层测试全部通过」/「全部通过」/「冒烟测试全部通过」） |
| 既有失败 | `node test/smoke.test.js` | **1**——`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`，**既有现象，非回归** |

边界见 `v1.2.0-notes.md` §7，其中三条必读：**① 子智能体的审批看不到（policy=never，动作自动拒绝）；
② 客户端模块必须完整重启 DSH 才会被加载；③ RPC secret 要先 base64url 解码成 32 字节再作 HMAC key（否则 401）。**

## v1.3.0（2026-10-05）

- 新增子智能体待批审批条（conversation.input.dock, order=25），子会话的待批在主对话可见并可直接允许一次/拒绝。
- lib/client.js 18034 → 28697 字符；test/client-approval.test.js 新增 10 例；package.json 1.3.0。
- 宿主 lib/index.js 未改动；回退方式见 v1.3.0/NOTES.md。

## v1.3.1（2026-10-05）

- 待批审批条把「要动什么」说清楚：完整多行原因（600 字符上限）、`工具/要做什么` 标签、来源会话标题、已等待计时、点后结果态、标题带工具名。
- `lib/index.js`：协作流程要求提权 justification 点名具体目标；修正「子会话高风险动作会被自动拒绝」的过时说法。
- 测试：client-approval 17 例全过（新增 6 + 1）；归档 `v1.3.1/`（MANIFEST.json 含逐文件 sha256）。
- 回退：拷贝 `v1.3.0/lib\{client,index}.js` 覆盖即可。

## v1.4.0（2026-10-05）

- 子智能体审批链路收口：DSH 本体 7 字节 asar 补丁（子会话 `never` → `ask`）+ `dsh-approval-gate` 兼容补丁
  （`permissionPresets.current(session)` 签名不匹配是 gate「零介入」的根因，修前 events.jsonl/audit.log 永为空）。
- readme 新增「运行前置：本机两处兼容补丁」；插件源码与 v1.3.1 逐字节相同，仅版本号与文档变化。
- 归档 `v1.4.0/`（MANIFEST.json 逐文件 sha256 + NOTES.md）。

## v1.4.1（2026-10-05）

- 待批审批条改为「任何等待我的审批都显示」：本会话自己那条只在原生审批卡片不在场时补位（`filterOwnIfNative`），
  子会话/其它会话的审批一律显示；来源标签区分 本会话 / 子会话 / 其它会话。修复「子会话审批登记在主会话键上时两边都不显示」。
- 删除排查用的临时诊断条（`byk-agents.diag` / `DiagStrip` / `.byk-diag`）。
- 测试：client-approval 20 例全过、plan 10 例全过、timing/smoke 全 0；`node --check` 10/10。宿主未改动。
- 归档 `v1.4.1/`（MANIFEST.json 逐文件 sha256 + NOTES.md）。回退 = 拷回 `v1.4.0/lib/client.js` 后刷新页面。

## v1.4.2（2026-10-05）

- 文档收口（功能零变更）：readme 版本行与「客户端模块」整章重写（待批审批条 + 跨会话镜像、显示规则 v1.4.1 定稿、
  4 条诚实边界、加载时机、F12 自检），补齐 client-approval 测试说明，删掉已删脚本 check-client-bundle.mjs 的失效引用；
  lib/client.js 头注释订正；package.json 1.4.2。
- 核实 `caps.toolFilter`：进程内 provider（dsh-subagent-fork-in-process:41 / dsh-subagent-spawn-in-process:27）为 true，
  进程外 provider（dsh-subagent:2527 / types/out-of-process.js:53）为 false → 本机默认路径支持 subagentTools 收窄。
- 实测「子智能体继承其它插件工具」：byk_role(code) 子智能体调用 dsh-ego-browser 的 `ego_status` → ok:true（自报工具 101 个、ego_* 35 个）。
- 测试全绿：node --check 11/11、client-approval 20、plan 10、timing、run-smoke。
- 归档 `v1.4.2/`（MANIFEST.json 逐文件 sha256 + NOTES.md）。回退 = 拷回 v1.4.1 对应文件后刷新页面。

## v1.5.0（2026-10-06）

- Jev 接入：新增 `byk_judge`（一条判定）与 `byk_judge_batch`（一次请求判多条）两个工具，实现层为新增的 `lib/jev.js`
  （18 KB，`createJevCaller` / `validateQuestion` / `normalizeHttpError` / `toJudgeJson` / `toBatchJson`）。
- 新增 `jev` 配置段（`lib/index.js:196`：`baseUrl` / `model` / `timeoutMs` / `apiKey`，留空回落到 lib/jev.js 默认值，
  key 找不到时工具明确报错并点名找过的位置，不静默降级）。
- 指令层写入「判断先行」：有界语义判断（分类 / 取舍 / 风险 / 验收）先拿判定再行动，结论里带 `value` 与 `confidence`
  并标注 `[jev]`（`lib/index.js:109/116/118`）；`lib/plan.js` 要求把判断写进该步 acceptance。readme 新增「Jev 判断」章节与配置示例。
- 测试与归档：新增 `test/jev.test.js`（14 组断言，桩 fetch 不联网）；归档 `v1.5.0/`（MANIFEST.json 逐文件 sha256 + NOTES.md），`v1.4.2/` 原样未动。
- 回退：单文件 `Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.2\lib\index.js' 'C:\Projects\byk\dsh-plugin\lib\index.js' -Force`；
  整版命令与 `rollback.mjs` 的已知不兼容见 `v1.5.0\NOTES.md`。

## v1.5.1（2026-10-06）

- 只补测试护栏与环境加固，不改运行行为。
- `test/smoke.test.js` 新增第 9 节：断言 `byk_judge` / `byk_judge_batch` 已注册、参数键齐备，且 `byk:workflow` 注入文本含「判断先行」。动因：v1.5.0 端到端验证暴露出冒烟 harness 对新工具零断言。
- `test/run-smoke.mjs` 加固：原用 junction 链接 profile 的 schemastery，收尾 `rmSync(recursive)` 会顺链接删进目标目录，实测删空了 `C:\coding\DSH Home\profiles\desktop\node_modules\@deepseek-ai\schemastery`（已从 DSH 自带副本恢复 3.18.4）；现改为 `cpSync` 真实复制 schemastery + cosmokit，临时目录不再外链。
- `lib/` 源码与 v1.5.0 逐字节相同；仅 `package.json`(1.5.1)、`readme.md` 版本行、`test/smoke.test.js`、`test/run-smoke.mjs` 有改动。
- 实测：全部自检 exit 0（lib --check ×7、plan、timing、client-approval 20 例、jev 14 组、run-smoke 9 节）；真 Jev 调用 noul/choice/score 与多题批量成功，伪造 key → `kind=auth`。
- 回退：`Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.5.0\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force`。


## v1.7.2（2026-10-27）

- **新增 `sandbox_heal` 工具 + `lib/sandbox-heal.js`**：修 Windows 沙箱 `windows-acl-run: --temp is not an existing directory: <路径>`（私有临时目录被删后每次带沙箱的调用都 127 失败，直到宿主重启）。
  - 按 DSH 的字节级口径复刻 `tempWriteSid`（sha256(`"temp\0"` + 路径) → `S-1-4-<a>-<b>-1`），路径不变所以受限令牌里的 capability SID 仍匹配；重建目录后用 PowerShell `SecurityIdentifier` 授 ACE（`icacls /grant *S-1-4-…` 会报「账户名与安全标识间无任何映射完成」，必须走 Win32/Set-Acl），再用 `icacls /setintegritylevel (OI)(CI)Low` 补 Low 完整性标签。
  - 已知差异：DSH 自己调用 `AclWriteGrant.add`，还会加一条 world SID 的 ambient-delete deny；自愈只补写 ACE + 标签，不加 deny（不影响写入，只是比原生目录略宽松）。
  - 插件激活时顺带做一次临时根目录预检（`ensureTempRoot`）；`runProcess` 遇到该错误签名会给助手追加「用 sandbox_heal 修」的提示。
- 测试：新增 `test/heal.test.js`（7 例，含按 DSH 实现取值的 SID 向量对齐 + opt-in 的真实 ACL 集成用例，需 `BYK_HEAL_TMP`）；`test/run-smoke.mjs` 全绿。
- 归档 `v1.7.2/`（34 个文件 + MANIFEST 逐文件 sha256，rollback --dry-run consistent 34/34）。
- 注意：`test/smoke.test.js` 不能直接 `node --test` 跑（依赖宿主解析 `@deepseek-ai/*`），必须走 `node test/run-smoke.mjs`。
## v1.6.0（2026-10-06）

- 新增**情绪判读**工具 `byk_mood`：一次 Jev 请求固定三问（情绪基调 choice / 着急程度 score / 这一轮最需要什么 choice），
  三问共用一份 state、走同一个请求。语义层为新增的 `lib/mood.js`（174 行 / 8648 字节）；
  `lib/index.js:43` 加 import，`lib/index.js:1105-1178` 注册工具（参数校验与结果透传，HTTP / key / 超时复用既有 jev 调用器），
  `lib/index.js:1180` 启动日志补上 `byk_mood`；协作流程注入段 `lib/index.js:134`（26 行）新增「先读情绪、再排任务」小节与四条边界。
- 缺陷 A 修复：`test/smoke.test.js` 的防递归用例不再把**环境问题**报成插件缺陷。修前在受限沙箱里
  `lib/index.js:407 runRole()` 会先无条件 `loadRegistry()`（→ `lib/index.js:236 spawn(..., stdio 管道)`）→ `spawn EPERM`，
  第 1 节的硬断言 `/拒绝调用/` 变成 `AssertionError … did not match /拒绝调用/ … smoke.test.js:70:8`。
  改法：`test/smoke.test.js:68-135` 新增显式前置探测（`probeRegistryForRecursionGuard()` / `isRegistryUnreadableResult()` / `skipNote()`），
  同一前置条件一并加到第 6/7/8 节（它们同样经 `runRole`），并新增第 10 节 4 组注入桩用例；
  收尾有跳过时打印「冒烟测试结束：N 处用例因环境跳过…」，全绿时仍是原句「冒烟测试全部通过」。
- 缺陷 B 修复（**不在本快照内**，属同批发布的工具修复）：`C:\Projects\byk\dsh-plugin-releases\rollback.mjs` 原先只认一种 MANIFEST 清单形态，
  对 v1.3.0 / v1.3.1（`files` 为 `{名: sha256}` 映射，v1.3.0 还是大写十六进制）与 v1.4.0 / v1.4.1（`{名: {sha256, size|bytes}}` 映射）
  会按清单结构错误退出（退出码 2）。现统一解析三种形态，退出码语义 0 / 1 / 2 不变；九个历史快照都能用同一条命令回退。
- 其他：`package.json` 1.5.1 → **1.6.0**（`files` 数组补 `lib/mood.js` / `test/mood.test.js` / `test/smoke.test.js`，共 17 项）；
  `readme.md` 同步三处：版本行与变更主线、「工具」表新增 `byk_mood` 行、新增「情绪判读（`byk_mood`）」章节；新增 `test/mood.test.js`（276 行）与 `test/smoke.test.js` 第 11 / 11b 节。
- 既有行为未变：`byk_role` / `byk_plan` / `byk_batch` / `byk_hire` / `byk_judge` / `byk_judge_batch` 六个既有工具的名称、参数、返回字段
  与角色模型映射全部未动；`lib/client.js`、`lib/jev.js`、`lib/plan.js`、`lib/routing.js`、`lib/timing.js`、`lib/asr.js`
  与 v1.5.1 **逐字节相同**（sha256 一致）。
- 归档 `v1.6.0/`（MANIFEST.json 逐文件 sha256 + NOTES.md；22 个插件文件，fileCount = 22）。
- 回退：`Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.5.1\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force`，
  或 `node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.5.1`。

## v1.6.1（2026-10-06）

> ⚠️ **已知缺陷（2026-10-06 实测）：本版 `byk_hire` 不可用** —— `spawnTeammate` 的必填字段 `provider` 漏传，真调返回「招募失败：Cannot read properties of undefined (reading 'trim')」。请使用 **v1.6.2**。

- **修掉 `byk_hire` 的招募缺陷**：cordis 只允许读 `inject` 里声明过的服务，直接读 `ctx.agentTeams` 会抛 `cannot get property "agentTeams" without inject`，连 `if (!ctx.agentTeams)` 这种兜底判断都会先炸 —— 真实会话里 `byk_hire` 因此必然失败。
- 改法：新增 `getService(ctx, name)`，走 `ctx.get(name)`（cordis `ReflectService.get` 官方逃生口「without the inject requirement」），退化路径 `ctx.reflect.get(name)`；inject 保持不变，仍是「没有 Agent Team 的 profile 里本插件不 pending」。
- 只动 `lib/index.js`（顶部注释 + `byk_hire` 取值/调用点 + 新增 `getService`）；`test/smoke.test.js` 新增第 12 节（12a 服务缺失友好兜底、12b 服务存在经 `ctx.get` 成功招人），393 → 457 行。
- 验证：`node test/run-smoke.mjs` 退出码 0、12 节全绿、末行「冒烟测试全部通过」；`node --check` 全过。
- 归档 `v1.6.1/`（MANIFEST.json 逐文件 sha256 + NOTES.md；22 个插件文件，fileCount = 22）。
- 注意：宿主插件代码改动需**完全重启 DSH Desktop** 才生效。

## v1.6.2（2026-10-06）

- **修掉 `byk_hire` 的第二层缺陷**：重启后真调仍报 `招募失败：Cannot read properties of undefined (reading 'trim')` —— `agentTeams.spawnTeammate` 的 `request.provider` **必填**（服务内 `requiredText(request.provider, "provider", 200)` → `value.trim()`），1.6.1 漏传。
- 改法：新增 `resolveHireProvider(ctx, configured)`（优先 `cfg.hire.provider`，否则取 `ctx.subagents.list()` 里的 `spawn`，没有则列表第一个）；调用点补 `provider`；`Config` 增加 `hire.provider`（默认 `"spawn"`）。
- 冒烟第 12 节扩到 12a/12b/12c（469 行），退出码 0、12 节全绿。
- 归档 `v1.6.2/`（MANIFEST 逐文件 sha256 + NOTES.md；22 个插件文件）。
- ⚠️ 同时把 v1.6.1 标为已知缺陷、勿回退。

## v1.6.5（2026-10-07）

- **修复**：桌面端设置页「数据通道不可用」——`/api/byk/assistants` 404。根因是 `webServer` 由 web bundle 在本插件之后挂载，v1.6.4 在 `apply()` 里同步取服务永远拿不到；改用 cordis 响应式 `ctx.inject(["webServer"])` 注册（与 DSH 自带 `dsh-api-gateway` 同款），并回落到 `getService` 兼容测试桩。
- 归档 `v1.6.5/`（30 个插件文件 + MANIFEST 逐文件 sha256 + NOTES.md）。
- 回退目标仍是 v1.6.0；上一版 v1.6.4。


## v1.6.4（2026-10-07）

- 新增 **设置页「BYK 助手」**（独立整页 + 内置插件 tab 两个入口）：助手增删改查、逐助手模型与后端配置。
- 新增后端 **`local-extract`**：文件/视觉助手可走 BYK 本地提取层（OCR / 文档解析 / faster-whisper），本地推理、无 API key、**禁止静默回落云端**。
- 新增 **助手覆盖层** `lib/assistants.js` + `<bykRoot>/byk/assistants.local.json`：运行时读取、改完立刻生效；未配置时与 v1.6.3 逐字段一致。
- 新增 `lib/local-extract.js`、`lib/settings-channel.js`（宿主 HTTP 通道 `/api/byk/assistants`）与 5 个测试文件。
- Python 侧：`C:\Projects\byk\byk\cli.py` 新增 `extract` 子命令（本地提取层的命令行入口）。
- 回退：`rollback.mjs v1.6.4 --dry-run` 看计划；或从 `v1.6.3` 目录覆盖。


## v1.6.3（2026-10-06）

- **纯文案修复**：`byk_hire` 的成功文案与交给 teammate 的初始任务都不再把注册表中的**静态基准模型**说成本次会用的模型，改为「按峰谷路由，以 `byk_role` 结果里打印的模型为准」。
- 触发：1.6.2 真机复验时发现文案写着 `deepseek-official/deepseek-v4-flash`，而实际执行走峰谷路由。行为本身无缺陷，不影响使用。
- 冒烟 12b 新增三条断言（含「不得出现具体模型名」的反例正则）；`test/run-smoke.mjs` 退出码 0、末行「冒烟测试全部通过」。
- 归档 `v1.6.3/`（22 个插件文件 + MANIFEST 逐文件 sha256 + NOTES.md）。
