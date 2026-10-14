# v1.4.0（子审批链路打通：gate 兼容补丁 + 归档）

## 本版内容

本版插件源码与 v1.3.1 **完全相同**（`lib/{index,client}.js` 逐字节相同），
版本号提升是因为「子智能体审批链路」这一整轮工作在此收口，并把两个本机补丁写进 readme。

1. **DSH 本体 app.asar 补丁**（7 字节）：子会话审批策略 `never` → `ask`，子智能体提权请求可以冒泡到主对话。
2. **dsh-approval-gate 兼容补丁**：`permissionPresets.current(session.events)` → 先试 `current(session)`，
   失败再回退旧写法。修前 gate 对所有审批零介入（`auto-approve/events.jsonl`、`audit.log` 永为空）。
3. readme 新增「运行前置：本机两处兼容补丁」小节。

补丁脚本、备份与回退命令统一在 `C:\Projects\byk\.byk-work\README.md`。

## 回退

- 插件本体：`Copy-Item dsh-plugin-releases\v1.3.1\lib\*.js dsh-plugin\lib\ -Force`（本版与 v1.3.1 无差异）。
- gate 补丁：`node C:\Projects\byk\.byk-work\patch-gate.mjs --revert`。
- asar 补丁：见 `.byk-work\README.md`（拷回 `backup\app.asar.orig`）。

两处补丁的回退都需要**完全退出 DSH 再启动**。
