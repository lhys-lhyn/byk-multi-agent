# dsh-plugin-byk-agents v1.3.0 — 子智能体待批审批在主对话里可见、可一键放行

新增日期：2026-10-05
上一版：v1.2.0（归档在同级 v1.2.0/）

## 解决什么问题

客户端 dsh-client-ui-approval 把待批项登记在**发起会话**（子会话）的 id 上
（lib/client.js:285 `ctx.sessions.scopeOf(owner)`，:343-354 卡片只挂当前会话的
conversation.composer），所以子智能体的审批卡片只出现在它自己的子会话里：
主对话看不到、也就没人能点 —— 实测中子会话的提权审批挂起 10 分钟，最后随父级
run_code 600s 超时被取消（tool/result Error: approval ... was cancelled）。

## 本版做了什么

lib/client.js 新增「子智能体待批审批」条，注册在 `conversation.input.dock`，
id `byk-agents.child-approvals`，order=25（排在 dsh-approval-gate 原生条 30 与
本插件既有的跨会话镜像 31 之前）：

- 数据源：`ctx.get('uiSession').sessionStatus` 的全局待批快照（dsh-client-ui-session
  lib/client.js:148-156 getSnapshot/subscribe，:299-313 按 sessionId 收录**所有**会话
  的待批项），配合会话列表行的 `parentId`（dsh-api-session-controller lib/client.js:3514）
  判断「是不是当前会话的后代」。
- 只显示**后代会话**的待批项；当前会话自己的待批仍交给原生卡片（不重复）。
- 一条谱系信息都拿不到时退化为「所有非当前会话」，宁可多显示也不漏掉正在等你的审批。
- 每条给「拒绝 / 允许一次」两个按钮：answer('rejected') / answer('allowed-once')
  （词表来自宿主 dsh-user-approval lib/index.js:31-32，'allowed-once' 是唯一授权）。
- 待批对象是 dsh-client-ui-approval 的 PendingApproval 实例（该模块私有、不能 import、
  不能 instanceof），本插件只把它当「有 answer()/answerable 的普通对象」使用；
  answer 抛错只告警一次，绝不影响对话。

## 文件变更

- lib/client.js 18034 → 28697 字符（新增待批审批模块、组件与 CSS；头部过时注释改写；
  历史视图文案更新为「子智能体的待批审批见输入框上方的提示条」）
- test/client-approval.test.js 新增（10 例，node 侧桩件加载 bundle 后测纯逻辑）
- package.json version 1.2.0 → 1.3.0，files 增 test/client-approval.test.js
- lib/index.js 未改动（宿主侧无变化）

## 验证

```
node --check lib/index.js lib/client.js lib/plan.js test/client-approval.test.js   # 全 exit 0
node test/client-approval.test.js    # 10 例全过
node test/plan.test.js               # 10 例全过
node test/timing.test.js             # 峰谷/路由全过
node test/run-smoke.mjs              # 8 段全过（byk_plan 3 步、byk_batch 3/3）
```

## 回退

1. 直接回退单文件：`Copy-Item v1.2.0/client.js ..\dsh-plugin\lib\client.js -Force`，
   再把 package.json 的 version 改回 1.2.0；
2. 或整目录回退：把 v1.2.0/ 下文件覆盖回 C:\Projects\byk\dsh-plugin\；
3. 纯前端改动，没有动 DSH 本体、没有动 profile 补丁；回退后刷新页面即可。
