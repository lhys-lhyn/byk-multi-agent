# v1.4.1（2026-10-05）

## 一句话
把「待批审批条」从「只显示子会话」改为「任何等待我的审批都显示」：本会话自己的那条**只在原生审批卡片不在场时**才由我们补一份，
既不漏（此前子会话的审批被登记在主会话键上时两边都不显示），也不重复（原生卡片在场时让位）。

## 为什么
- 客户端把待批项登记在 `ctx.sessions.scopeOf(owner)`（@deepseek-ai/dsh-client-ui-approval lib/client.js:285）算出的会话键上；
  子智能体的审批可能被登记在**主会话**键上，也可能登记在子会话裸 uuid 上（主会话 id 带 `session-` 前缀、子代理是裸 uuid）。
- v1.3.1/v1.4.0 的语义是「排除 owner === 当前会话的待批」，于是「登记在主会话键上的子会话审批」两边都不显示——实测就是这样
  （用户只看到旧的只读镜像条，看不到按钮）。
- v1.4.1 的语义：宁可多显示，绝不漏掉。所有已知待批都渲染；仅当页面上已经存在原生审批面板
  （`document.querySelector('[class*="ApprovalPanel_module"]')`）时，才把「本会话自己那条」让给原生卡片。

## 改了什么（仅客户端 bundle + 版本/测试）
- `lib/client.js`（31542B → 32390B，净 +10/-20 行）：新增纯函数 `filterOwnIfNative(items, nativePresent)` 与
  `hasNativeApprovalPanel()`；`visibleChildPendings()` 不再按谱系过滤（仍保留「当前会话 id 未知时不显示」）；
  待批条改用 `filterOwnIfNative(view.items, hasNativeApprovalPanel())`；来源标签区分 本会话 / 子会话 / 其它会话。
- 排查用的临时诊断条（`byk-agents.diag` / `DiagStrip` / `.byk-diag` CSS）已全部删除。
- `package.json` 1.4.0 → 1.4.1；`test/client-approval.test.js` 17 → 20 例。
- 宿主 `lib/index.js`、`lib/routing.js`、`lib/timing.js`、`lib/plan.js`、`lib/asr.js`、`scripts/` 未改动。

## 验证
- `node --check` 10/10 退出码 0；`test/client-approval.test.js` 20 例全过；`test/plan.test.js` 10 例全过；
  `test/timing.test.js`、`test/run-smoke.mjs` 全退出码 0。
- 真实下发核验：首页 HTML 里抓 `plugins/??dsh-plugin-byk-agents/client.js&rev=<hex>`，内容含 `filterOwnIfNative`、不含 `byk-diag`。
- 生效方式：**刷新页面**即可（客户端 bundle 按 mtime/size 重新下发），无需重启 DSH。

## 回退
```powershell
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.0\lib\client.js' 'C:\Projects\byk\dsh-plugin\lib\client.js' -Force
```
（v1.4.0 的 client.js 就是 v1.3.1 那份。）测试文件与 package.json 如需一致，也从 v1.4.0/ 拷回；再刷新页面。
