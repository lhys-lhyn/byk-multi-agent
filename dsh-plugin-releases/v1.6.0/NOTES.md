# v1.6.0 归档说明（2026-10-06）

- 版本：**1.6.0**（1.5.1 → 1.6.0，新增工具属功能，语义化取 minor）
- 快照时间：archivedAt = `2026-10-06T01:09:33.042Z`（见 MANIFEST.json，同一时刻写入）
- 来源：`C:\Projects\byk\dsh-plugin`
- 内容：22 个插件文件（按原相对路径平铺在本目录）+ `MANIFEST.json` + 本文件；`MANIFEST.json` 的 `fileCount = 22` 与条目数一致，条目键为 **path**（`{path, bytes, sha256}`），逐文件真实 sha256，不含 node_modules / .git / 临时产物。
- 与真实插件目录逐文件比对：22 个条目里 **20 个 sha256 与磁盘一致**，只有 `package.json`（1027 → 1096 字节）与 `readme.md`（23183 → 25447 字节）是本次改动的两个文件。

## 一、本次变更（两类）

### 类别 1：两个缺陷修复

**缺陷 A —— 冒烟测试的防递归用例在受限沙箱下把环境问题报成插件缺陷。**

- 症状：在主对话的受限沙箱里跑 `node test/run-smoke.mjs`，第 1 节（防递归护栏）失败，报
  `AssertionError: 期待匹配 /拒绝调用/，实际：无法读取角色定义：读取角色注册表失败（退出码 -1）：无法启动进程：spawn EPERM`（`test/smoke.test.js:70:8`）。
- 根因：该用例走 `lib/index.js:407 runRole()`，而 `runRole()` 会**无条件先** `loadRegistry()`（`lib/index.js:361`）→ `runProcess`（`lib/index.js:362`）→ `spawn(..., stdio 管道)`（`lib/index.js:236`）。
  管道 stdio 在受限沙箱里抛 `spawn EPERM`，于是 `lib/index.js:415-419` 先返回「读取角色注册表失败」，用例拿不到预期的「拒绝调用」字符串。
  这是**测试把环境限制误判为产品缺陷**，不是插件运行时缺陷（同样的路径在正常环境里能正常读到注册表）。
- 改法（`test/smoke.test.js`，本次由 10361 字节增到 21663 字节 / 393 行）：`test/smoke.test.js:68-135` 新增显式前置探测
  —— `REGISTRY_UNREADABLE`(:76) 哨兵、`skipNote()`(:81)、`isRegistryUnreadableResult()`(:95)、`probeRegistryForRecursionGuard()`(:100)、`section1RecursionGuard()`(:112)：
  先把「注册表可读吗」探测清楚，不可读时**打印跳过原因并跳过**，而不是把它断言成缺陷。
  同一前置条件一并加到第 6 / 7 / 8 节（它们同样经由 `runRole`）；新增第 10 节 4 组**注入桩**用例，其中两条反例保证「注册表可读时仍然硬断言 /拒绝调用/」，防止跳过逻辑把真缺陷一起吞掉。
  收尾汇总：有跳过时打印「冒烟测试结束：N 处用例因环境跳过…」；无跳过、全绿时仍是原句「冒烟测试全部通过」（退出码 0）。
- 影响：冒烟在受限沙箱与正常环境下**都**可用且结论不撒谎——环境问题标为「跳过」，产品问题仍是失败。既有 11 节在正常环境下行为不变。

**缺陷 B —— `rollback.mjs` 只认一种 MANIFEST 清单形态，历史快照大多回退不了。**

- 症状：对 v1.3.0 / v1.3.1 / v1.4.0 / v1.4.1 这四个历史快照执行回退，脚本按清单结构直接报错退出（退出码 2），九个历史快照里只有四种能用。
- 根因：历史清单实际存在**三种**形态，而脚本只实现了一种：
  - 形态 A：`files` 是**条目数组**，条目键为 `relPath` 或 `path`（v1.1.0-baseline、v1.2.0、v1.4.2、v1.5.0、v1.5.1）；
  - 形态 B：`files` 是 **`{文件名: sha256}` 映射**（v1.3.0 是大写十六进制、v1.3.1 是小写）；
  - 形态 C：`files` 是 **`{文件名: {sha256, size|bytes}}` 映射**（v1.4.0、v1.4.1，且尺寸键名不统一）。
- 改法：`rollback.mjs` 统一解析三种形态（条目数组 / 值即哈希的映射 / 值含哈希的映射），大小写哈希统一按小写比较，尺寸键 `size` 与 `bytes` 都接受。
- 影响：九个历史快照全部可用同一条命令回退，退出码语义（0 = 一致、1 = 不一致、2 = 用法/结构错误）不变。
- **注意**：`rollback.mjs` 不在本快照内——它住在 `C:\Projects\byk\dsh-plugin-releases\rollback.mjs`，属于发布工具而非插件内容。本快照的 MANIFEST 采用形态 A + `path` 键，正是修好后能被正确解析的形态。

### 类别 2：新增情绪判读 `byk_mood`

- 目的：让主对话在排任务之前，先用一次判断拿到「用户这轮的情绪与诉求」，避免对着着急的用户做长篇规划。
- 实现：新增语义层 `lib/mood.js`（174 行 / 8648 字节）；`lib/index.js:43` 加 import；
  `lib/index.js:1105-1178` 注册 `byk_mood`（参数校验与结果透传，HTTP 请求 / key 读取 / 超时复用既有 `lib/jev.js` 调用器，不新增依赖）；
  `lib/index.js:1180` 启动日志补上 `byk_mood`。
- 关键设计：**一次 Jev 请求固定三问**——情绪基调（choice）/ 着急程度（score）/ 这一轮最需要什么（choice），三问共用一个 `state`、走同一个请求（`lib/index.js:1105` 的注释即写明这一点），因此成本与延迟接近一次普通判断，而不是三次。
- 协作流程：`lib/index.js:134`（BYK_WORKFLOW 注入段，新增 26 行）加入「**先读情绪、再排任务**」小节与四条使用边界（什么时候该读、什么时候别读、结果怎么用、不许把具体场景写死——写死会让规则失效又费钱）。
- 影响：`lib/index.js` 由 55579 字节 / 1050 行档位的 1.5.1 版变为 62343 字节 / 1185 行；相对 1.5.1 只有 4 个 hunk（`@@ -42,0 +43,6 @@`、`@@ -127,0 +134,26 @@`、`@@ -1072,0 +1105,74 @@`、`@@ -1074 +1180 @@`），全部与 mood 相关，没有顺带改别的逻辑。
- 测试：新增 `test/mood.test.js`（276 行 / 14268 字节）；冒烟新增第 11 / 11b 节覆盖 `byk_mood` 的注册与三问契约。

## 二、既有行为未变（兼容性）

- 六个既有工具的名称、参数、返回字段**全部未动**：`byk_role`、`byk_plan`、`byk_batch`、`byk_hire`、`byk_judge`、`byk_judge_batch`。`byk_mood` 是**纯新增**，不改任何既有工具的签名与返回结构。
- 角色模型映射与路由（`lib/routing.js`）、计划与批次调度（`lib/plan.js`）、Jev 调用（`lib/jev.js`）、审批条客户端（`lib/client.js`）、计时（`lib/timing.js`）、语音（`lib/asr.js`）与 v1.5.1 **逐字节相同**（sha256 一致，见下）。
- `package.json` 只改 `version`：`files` 数组仍是 17 项（其中 `lib/mood.js` / `test/mood.test.js` / `test/smoke.test.js` 是 1.5.1 版本行里已经加好的），其余字段未动。
- `readme.md` 的三处改动：① 第 6 行版本行与变更主线；② 第 32 行「工具」表新增 `byk_mood` 一行（紧随 `byk_judge_batch`）；③ 新增「## 情绪判读（`byk_mood`）」章节（参数 / 返回字段 / 四条边界，插在「## 峰谷路由」之前）。其余章节未变。

## 三、验证证据（本次归档时实跑）

1. MANIFEST 自校验：22 个条目逐个比对目录内实际文件的 `size` 与 `sha256` → **ALL 22 OK**。
2. 形态可解析性：`node C:\Projects\byk\dsh-plugin-releases\rollback.mjs <本快照> --dry-run` → `consistent : 22 / 22`、`inconsistent: 0`、退出码 **0**（即本快照能被修好的 `rollback.mjs` 正确校验，也证明归档目录形态与 v1.5.1 同款）。
3. 语法：对本快照内 `lib/index.js`、`lib/mood.js`、`lib/client.js`、`test/smoke.test.js`、`test/mood.test.js` 逐个 `node --check` → 退出码全部 **0**。
4. `RELEASES.md`：新版 16301 字节，前 13379 字节与线上原文件**逐字节相同**（历史条目未被改动），尾部新增 1.6.0 条目。
5. 冒烟测试：11 节全绿、退出码 0、末行「冒烟测试全部通过」（该结果由上游会话在改动完成时取得，本快照的字节与其一致；本次归档未重复运行插件测试）。

## 四、回退方法

```powershell
# 方式一（推荐：带 sha256 校验）
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.5.1
# 方式二（直接覆盖）
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.5.1\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force
```

覆盖前建议先看 dry-run（加 `--dry-run`），会打印每个文件是否与快照一致。
