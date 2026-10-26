# v1.7.0 — byk_role 后台模式（解决助手被 600 秒掐死）

## 为什么要这一版

大任务（例如「盘点 DSH 现状」要读完 23 个包再写报告）动辄 15–40 分钟。历史上有两次派 code 助手盘点，
因为主控把 byk_role 嵌在 run_code 程序体内调用，被 run_code 的 600 秒硬顶连坐掐掉：助手没跑完、
文件没写出来、整段产出丢失。

## 这一版改了什么

1. **byk_role 新增 `background` 参数**（默认 false，默认路径行为与旧版一致）：
   传 true 时立刻返回 `taskId`，助手在宿主进程里继续跑，结果写盘；主控可以继续干别的。
2. **新增 byk_status 工具**：不带 task_id 列出全部后台任务（id / 角色 / 模型 / 状态 / 耗时）；
   带 task_id 取回结果文本（超长截断，并给出完整 result.json 路径）。
3. **落盘位置**：`<bykRoot>/.byk-work/bg-tasks/<taskId>/`（meta.json + result.json），
   自动只保留最近 30 个任务。**不写 %TEMP%** —— 那里的 dsh-* 由宿主沙箱管理。
4. **提示词纪律**：明确「不要把 byk_role 嵌在 run_code 里调用」「单步 ≤8 分钟」
   「长任务用 background:true 并把报告落盘」。
5. 新模块 `lib/bg.js`（纯函数，9 个用例）与 `test/bg.test.js`。

## 回退方式

```
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.7.0 --dry-run
node C:\Projects\byk\dsh-plugin-releases\rollback.mjs C:\Projects\byk\dsh-plugin-releases\v1.7.0 --prune
```

回退到上一版（1.6.5）就把上面的路径换成 v1.6.5；脚本会先把当前插件备份到 pre-rollback-<时间戳>。

## 生效方式

byk_role / byk_status 是**服务端**工具，改完必须完全重启 DSH Desktop 才会加载。

## 已知边界

- 后台任务只活在宿主进程里：DSH 重启会中断正在跑的后台助手，但已经写出的 result.json 还在。
- 非 llm 后端（local / local-extract / asr）同样支持 background，但这类任务通常只有几秒。

# v1.7.1 — 修 1.7.0 后台模式必崩的 signal 替换

1.7.0 用 `new Proxy(exec, {get:...})` 换 signal：宿主传来的 `exec.signal` 是**只读且不可配置**的自有属性，
Proxy 的 get 陷阱对这类属性必须返回原值，返回别的值直接 `TypeError`：

```
TypeError: 'get' on proxy: property 'signal' is a read-only and non-configurable data property on the
proxy target but the proxy did not return its actual value
```

实测后果：每个 `background:true` 的 byk_role 立刻失败（taskId 建好、0.0s、result 里是异常栈）。

改法（lib/index.js `startRoleInBackground`）：

```js
const bgDescs = Object.getOwnPropertyDescriptors(exec);
bgDescs.signal = { value: ctrl.signal, writable: true, enumerable: true, configurable: true };
const bgExec = Object.create(Object.getPrototypeOf(exec), bgDescs);
```

先改写描述符再建副本 —— 直接 `Object.create(proto, descriptors)` 复制后重建会抛 `Cannot redefine property: signal`，
这一点在隔离自检里已踩到并修正。保留原型链与 `agent` 等属性，原 `exec.signal` 不被改动。

回退注意：**回退到 v1.7.0 会把这个崩溃带回来**；要稳定回 v1.6.5（无后台模式），要功能留 v1.7.1。
