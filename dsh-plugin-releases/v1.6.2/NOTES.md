# v1.6.2 归档说明（2026-10-06）

- 版本：**1.6.2**（1.6.1 → 1.6.2，纯缺陷修复，语义化取 patch）
- 快照时间：archivedAt = `2026-10-06T01:48:15.845Z`
- 来源：`C:\Projects\byk\dsh-plugin`
- 内容：22 个插件文件 + `MANIFEST.json` + 本文件；`fileCount = 22`，条目键 `path`（`{path, bytes, sha256}`）。

## 一、为什么有 1.6.2（1.6.1 是坏的）

1.6.1 修掉了「读 `ctx.agentTeams` 撞 cordis inject 守卫」，重启后真调仍失败，暴露下一层缺陷：

- 症状（重启后真实会话实测）：`byk_hire({role:'code'})` → `{"ok":false,"name":"byk-code","text":"招募失败：Cannot read properties of undefined (reading 'trim')"}`；`list_agents` 仍只有 Lead。
- 根因：`agentTeams.spawnTeammate(caller, request)` 的 `request.provider` **必填**。服务实现 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js` 的 `544 spawnAdmitted()`：`:551 requiredText(request.description, …)`、`:557 requiredText(request.provider, "provider", 200)`，而 `requiredText`（`:322-327`）第一行 `value.trim()` → 漏传即 undefined.trim() 抛 TypeError；provider 随后转交 `ctx.subagents.startContinuable({provider, …})`（`:573-582`）。
- 官方参照：`@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:271-292` 显式传 `provider: context === "fork" ? config.forkProvider : config.freshProvider`（Config 默认 `freshProvider: "spawn"` / `forkProvider: "fork"`，`:14-19`）。后端注册名：`dsh-subagent-spawn-in-process` → `providerName` 默认 `spawn`（全新上下文）、`dsh-subagent-fork-in-process` → 默认 `fork`（带父会话已完成轮次前缀）。

## 二、本次改法

- 新增 `resolveHireProvider(ctx, configured)`：`ctx.subagents.list()` 取可用列表（`subagents` 本就在 inject 里）；显式配置优先，否则选 `spawn`，没有 `spawn` 时退回列表第一个；绝不返回 undefined。
- `byk_hire` 调用点补 `provider`；`Config` 新增 `hire.provider`（`z.string().default("spawn")`）。
- inject 声明、六个工具的名字/参数/返回结构、路由 / 计划 / Jev / mood / asr 全部未动。

## 三、验证证据

- 冒烟第 12 节 12a/12b/12c（`test/smoke.test.js` 457 → 469 行）：12b 断言 `provider="spawn"` 且招人成功；12c 伪造 `subagents.list() = ["fork"]` 断言按可用列表挑、不硬编码。
- `node test/run-smoke.mjs` 退出码 **0**、12 节全绿、末行「冒烟测试全部通过」；`node --check` 退出码 **0**。
- 本快照 MANIFEST 自校验与 `rollback.mjs --dry-run` 见 RELEASES.md。

## 四、仍未完成

- **真实会话复验未做**：宿主插件代码需完全重启 DSH Desktop 才生效，本快照落地后需重启并真调一次 `byk_hire` 才算闭环。
- `rollback.mjs` 非 dry-run 真写盘路径仍未实测。

## 五、回退方法

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.6.0
```

（不要回退到 v1.6.1：那一版 `byk_hire` 缺 `provider`，招募必失败。）
