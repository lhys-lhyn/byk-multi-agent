# v1.6.3 归档说明（2026-10-06）

- 版本：**1.6.3**（1.6.2 → 1.6.3，纯文案修复，语义化取 patch）
- 快照时间：archivedAt = `2026-10-06T01:53:35.543Z`
- 来源：`C:\Projects\byk\dsh-plugin`
- 内容：22 个插件文件 + `MANIFEST.json` + 本文件；`fileCount = 22`，条目键 `path`（`{path, bytes, sha256}`）。

## 一、为什么有 1.6.3（只改了两句提示，不改行为）

1.6.2 让 `byk_hire` 真正可用后，真机复验时发现它回的那句话把模型说死了：

- 旧文案：`已招入 teammate \`byk-code\`（代码助手）。它出现在团队面板与任务板上；执行任务时它会调用 byk_role（deepseek-official/deepseek-v4-flash）。`
- 问题：那个模型名来自角色注册表的**静态基准值**（`registry[role].provider/model`），而 `byk_role` 实际执行时走**峰谷路由**（结果里自己会打印解析到的真实模型，例如低谷的 `deepseek-official/deepseek-flash effort=high`）。文案把「配置值」写成了「本次会用的值」，会误导 Lead 与 teammate。

## 二、本次改法（`lib/index.js`，1248 行）

- 交给 teammate 的初始任务（原 `:970`）：`该角色的模型由峰谷路由决定（注册表基准：<provider/model>，未标注时显示「未标注」）；真实用的是 \`byk_role\` 结果里打印的那个模型。`
- `byk_hire` 成功文案（原 `:991`）：`…执行任务时它会调用 byk_role（按峰谷路由选模型，以结果里打印的模型为准）。`
- 其余一律未动：inject 声明、六个工具与 `byk_mood` 的名字/参数/返回结构、路由、计划、Jev、asr 全部原样。

## 三、验证证据

- 冒烟第 12b 节新增三条断言（`test/smoke.test.js` 469 → 472 行）：成功文案必须含「峰谷」；不得出现任何具体模型名（反例正则 `deepseek-v4-flash|deepseek-flash ｜低谷`）；交给 teammate 的初始任务同样必须含「峰谷」。
- `node test/run-smoke.mjs` 退出码 **0**、20 行输出、末行「冒烟测试全部通过」；唯一一处 `SKIP:` 是第 10 节**故意**用桩模拟「注册表不可读」的用例（`test/smoke.test.js` 第 10 节），非环境退化。
- `node --check lib/index.js` 退出码 **0**。

## 四、仍未完成

- 本次是纯文案改动，**仍需完全重启 DSH Desktop 才生效**；重启前真调 `byk_hire` 看到的仍是旧句子（1.6.2 的行为本来就是对的，功能不受影响，可继续用）。
- `rollback.mjs` 非 dry-run 真写盘路径仍未实测。

## 五、回退方法

```powershell
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.6.2
```

（不要回退到 v1.6.1：那一版 `byk_hire` 缺 `provider`，招募必失败。功能完好的上一版是 v1.6.2。）
