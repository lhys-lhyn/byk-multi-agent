# dsh-plugin-byk-agents v1.5.1

归档时间：2026-10-06T00:32:51.106Z　上一版：v1.5.0

## 本版改了什么（都不改运行行为）
- `test/smoke.test.js` 新增第 9 节：断言 `byk_judge` / `byk_judge_batch` 已被 `ctx.tools.register` 注册、参数键齐备，且注入的 `byk:workflow` 段落含「判断先行」与 `byk_judge`。起因：v1.5.0 的端到端验证发现冒烟 harness 对新工具**零断言**（工具没注册也照样全绿）。
- `test/run-smoke.mjs` 加固：准备依赖时原本用 `symlinkSync(..., 'junction')` 链到 profile 的 `@deepseek-ai/schemastery`，而收尾 `rmSync(root, {recursive:true})` 在 Windows 上会**顺着 junction 删进目标目录**——2026-10-06 实测把 `C:\coding\DSH Home\profiles\desktop\node_modules\@deepseek-ai\schemastery` 删空（已用 DSH 自带副本恢复为 3.18.4，5 项内容齐全）。现改为 `cpSync` 真实复制 `schemastery` + `cosmokit` 到临时目录，临时目录内不再有任何指向外部的链接。
- `package.json` version 1.5.0 → 1.5.1；`readme.md` 版本行同步。**`lib/` 下源码与 v1.5.0 逐字节相同**。

## 验证证据（本机实跑）
- 全部自检：`node --check` lib 下 7 个 .js 全 exit 0；`test/plan.test.js`、`test/timing.test.js`、`test/client-approval.test.js`（20 例）、`test/jev.test.js`（14 组）、`test/run-smoke.mjs`（9 节）全 exit 0。
- 真 Jev 调用（走 `lib/jev.js` 的 `createJevCaller`，真 key）：noul 0.1 / choice「验证1 真 Jev 调用」conf 0.58 / score 0.03 conf 0.96，`judge_model=jev-1.13.0`、usage 均有；多题一次调用 `toBatchJson` 正常；伪造 key → `kind=auth`（HTTP 401）。
- 独立注册核查（假 ctx 真加载 `lib/index.js`）：注册 6 个工具 `[byk_role, byk_plan, byk_batch, byk_hire, byk_judge, byk_judge_batch]`，注入段 `byk:workflow` 含「判断先行」。
- 加固后回归：跑完 run-smoke 再查 profile 的 schemastery，5 项俱在、package.json 在位。

## 回退
- 回 v1.5.0：`Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.5.0\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force`。
- 回 v1.4.2（Jev 接入前）：`Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.2\*' 'C:\Projects\byk\dsh-plugin\' -Recurse -Force` 并删除 `lib\jev.js`、`test\jev.test.js`、`docs\jev-planning-spec.md`。
- 注意：宿主侧插件代码改动要**完全重启 DSH Desktop** 才生效（pluginManager 开关不会重载代码）；客户端 bundle 只刷新页面即可。
