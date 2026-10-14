# v1.6.5（2026-10-07）

## 修了什么

**设置页「数据通道不可用」**：v1.6.4 重启后，设置页能显示（客户端 bundle 生效、`diagnostics` 也服务了），但列表区报：

```
数据通道不可用：数据通道响应读不出来: Unexpected token 'o', "not found" is not valid JSON
```

根因：`/api/byk/assistants` **404**（浏览器带 cookie 拿到纯文本 `not found`；不带 cookie 是 401，说明请求根本没进路由表）。
同一个 webServer 上 `dsh-approval-gate` 的 `/api/auto-approve/events` 正常，区别是它把 `webServer` 写进了 cordis `inject`。
而 `webServer` 由 web bundle 在**本插件之后**挂载（本机 `cordis.patch.yml`：byk-agents 在 116 行，web 那批在后），
所以 v1.6.4 在 `apply()` 里同步 `getService(ctx, "webServer")` 永远拿不到 —— 走 else 分支只打了条 warn，路由从未注册。

修法：改用 cordis 的**响应式注入** `ctx.inject(["webServer"], (webCtx) => registerSettingsRoute(...))`
（= 一个等到服务就绪才 apply 的子 fiber，与 DSH 自带 `dsh-api-gateway` 对 webServer 的用法一致）：
服务出现时注册，永不出现也只是不注册，**不会**把本插件 entry 拖成 pending；测试桩/老 cordis 没有 `ctx.inject` 时回落到 `getService` 同步试一次。

## 验证

- `node --check lib/index.js` exit 0；单测 10 套全 PASS（含新增集成断言「必须用 `ctx.inject(["webServer"])` 注册」）；`test/run-smoke.mjs` 全绿。
- **真机验证仍待一次完整重启**（宿主插件代码不热重载）：重启后设置页应出现助手列表；`GET /api/byk/assistants` 应返回 JSON。

## 回退

- 上一版：`C:\Projects\byk\dsh-plugin-releases\v1.6.4`
- `node rollback.mjs v1.6.5 --dry-run` 看计划
