# v1.6.1 归档说明（2026-10-06）

> ⚠️ **已知缺陷（2026-10-06 实测）：本版 `byk_hire` 不可用** —— `spawnTeammate` 的必填字段 `provider` 漏传，真调返回「招募失败：Cannot read properties of undefined (reading 'trim')」。请使用 **v1.6.2**。

- 版本：**1.6.1**（1.6.0 → 1.6.1，纯缺陷修复，语义化取 patch）
- 快照时间：archivedAt = `2026-10-06T01:35:01.121Z`（见 MANIFEST.json，同一时刻写入）
- 来源：`C:\Projects\byk\dsh-plugin`
- 内容：22 个插件文件（按原相对路径平铺在本目录）+ `MANIFEST.json` + 本文件；`fileCount = 22` 与条目数一致，条目键为 **path**（`{path, bytes, sha256}`），逐文件真实 sha256，不含 node_modules / .git / 临时产物。

## 一、本次变更（一处缺陷修复）

**缺陷 —— `byk_hire` 在真实宿主里必然失败：取 `agentTeams` 会先撞上 cordis 的 inject 守卫。**

- 症状（真实会话实测）：调用 `byk_hire({role:'code'})` 直接抛 `cannot get property "agentTeams" without inject`，`ok/name/text` 一个都拿不到；同一时刻 `list_agents` 里只有 Lead、`send_message` 报 `active teammate "byk-code" not found`、`wait_agent` 回 `noProgress/no-active-peer`。
- 根因：`lib/index.js` 第 67 行的 `inject` 只有 `["tools","subagents","systemPrompt"]` —— `agentTeams` 是**刻意不注入**的（它只在启用 Agent Team 的 profile 里存在，注入会让本插件在不启用的 profile 里永远 pending）。但 cordis 4.0.4 的服务代理只允许读 inject 里声明过的服务：读 `ctx.agentTeams` 这个动作本身就会被守卫拦截并抛错，于是 `byk_hire` 里那句本意的兜底 `if (!ctx.agentTeams)` 永远走不到。
- 改法：新增模块级助手 `getService(ctx, name)`，优先走 `ctx.get(name)`（cordis `ReflectService.get` 的官方逃生口，doc 原文：*Read a service from the store without the inject requirement*），失败再退到 `ctx.reflect.get(name)`，都没有则返回 `undefined`；`byk_hire` 改为用它的返回值做兜底判断与 `spawnTeammate` 调用。inject 声明保持不变，设计意图不变。
- 为什么这条逃生口可靠：cordis 4.0.4 在构造时就把 `get/set/provide/accessor/mixin` 混入 `ctx`（`this.mixin("reflect", [...])`），且 DSH 自带的 `@deepseek-ai/dsh-api-gateway` 就是这么用（`const connection = this.ctx.get("connection")`）。
- 影响面：只动 `lib/index.js` 三处（顶部注释、`byk_hire` 的取值与调用点）+ 新增 `getService`；六个工具的名字/参数/返回结构、路由、计划、Jev、mood、asr 全部未动。

## 二、验证证据

- 新增冒烟第 12 节（`test/smoke.test.js`，393 → 457 行）：造一个「访问 `.agentTeams` 必抛 inject 守卫错误」的假 ctx 复现当时上下文，断言 12a 服务缺失时友好兜底 `ok:false` 且不抛、12b 服务存在时经 `ctx.get` 取到并真的带着 `name=byk-code` / `context=fresh` / 含 `byk_role` 与 `extra` 的初始任务调用 `spawnTeammate`。
- `node test/run-smoke.mjs` → 退出码 **0**，12 节全绿，末行「冒烟测试全部通过」，其中 12a / 12b 均打印 OK。
- `node --check lib/index.js`、`node --check test/smoke.test.js` → 退出码 **0**。
- 本快照 `rollback.mjs --dry-run` → `consistent : 22 / 22`，退出码 0。

## 三、未完成/待办

- 插件是宿主代码，**必须完全重启 DSH Desktop 才生效**（pluginManager 开关不重载代码）。本快照落地后需重启并真调一次 `byk_hire` 复验。
- `rollback.mjs` 的非 dry-run 真写盘路径仍未实测。

## 四、回退方法

```powershell
# 方式一（推荐：带 sha256 校验）
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.6.0
# 方式二（直接覆盖）
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.6.0\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force
```

覆盖前建议先看 dry-run（加 `--dry-run`）。
