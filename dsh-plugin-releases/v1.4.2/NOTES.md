# v1.4.2 — 文档收口与能力核实（2026-10-05）

> 这一版**没有任何功能性代码改动**（唯一代码改动是 `lib/client.js` 顶部注释）。它的价值是把
> v1.3.0 → v1.4.1 之间攒下的文档欠账一次还清，并把两件此前"只写在文档里、未经实测"的话变成有证据的结论。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `readme.md` | 版本行 1.2.0 → 1.4.2 并重述变更主线；「客户端模块」整章重写（旧文说"子智能体审批看不到、超出本插件职责范围"、"当前会话自己的审批不显示"——全部过时）；补 `test/client-approval.test.js`；删掉已删除脚本 `check-client-bundle.mjs` 的失效引用 |
| `lib/client.js` | 顶部注释改为 v1.4.1 的实际语义（取出所有待批项；本会话那条仅在原生面板在场时让位） |
| `package.json` | 1.4.1 → 1.4.2 |

## 两条新证据

1. **`caps.toolFilter` 真值已核实**（此前文档写"未核实"）：
   - `@deepseek-ai\dsh-subagent-fork-in-process\lib\index.js:41` → `toolFilter: true`
   - `@deepseek-ai\dsh-subagent-spawn-in-process\lib\index.js:27` → `toolFilter: true`
   - `@deepseek-ai\dsh-subagent\lib\index.js:2527` 与 `lib\types\out-of-process.js:53` → `toolFilter: false`（进程外 provider）
   - 结论：本机默认的进程内 provider 支持 `subagentTools` 收窄；只有进程外 provider 会抛 `UNSUPPORTED_CAPABILITY`（`dsh-subagent\lib\index.js:3188-3196`）。
2. **"子智能体继承其它插件的工具"已实测成立**（对应需求：让智能体也能直接调用别的插件，不重复造轮子）：
   - 用 `byk_role(code)` 拉起子智能体，让它调用 `tools.ego_status({})`（`dsh-ego-browser` 插件注册的全局工具，**不是**宿主内置工具）。
   - 返回 `{"ok":true,"available":true,"path":"C:\\coding\\DSH Home\\profiles\\desktop\\node_modules\\dsh-ego-browser\\runtime\\ego-linux\\bin\\ego-browser.mjs","exitCode":0}`，外层耗时 5.1s，路由 `deepseek-official/deepseek-flash effort=high ｜低谷`。
   - 子会话自报工具总数 101，其中 `ego_*` 系列 35 个。

## 验证

- `node --check` 11/11（lib 下 6 个 + scripts/asr-mimo.mjs + 4 个 test 入口）
- `node test/client-approval.test.js` 20 例全过 ｜ `node test/plan.test.js` 10 例全过 ｜ `node test/timing.test.js` 全过 ｜ `node test/run-smoke.mjs` 全过
- 宿主侧下发核验：首页 rev=`d6f324460bdd` → `plugins/??dsh-plugin-byk-agents/client.js&rev=d6f324460bdd` 200 / 32529 字符，含「子智能体待批审批」与 `filterOwnIfNative`，不含排查用的 `byk-diag`
- pluginManager：`include:byk-agents` enabled=true fiberPhase=active；`include:dsh-approval-gate` enabled=true fiberPhase=active

## 回退

单文件回退（本轮唯一被改的代码文件是注释）：

```powershell
Copy-Item 'C:\Projects\byk\dsh-plugin-releases\v1.4.1\lib\client.js' 'C:\Projects\byk\dsh-plugin\lib\client.js' -Force
```

整版回退：把 `v1.4.1\` 下的 17 个文件拷回 `C:\Projects\byk\dsh-plugin\` 对应位置，**刷新页面**即可（客户端 bundle 改内容不需要重启 DSH）。
