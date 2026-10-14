# v1.6.4（2026-10-07）

## 这一版做了什么

1. **设置页「BYK 助手」（新）**：两个入口（独立整页 + 内置插件 tab），可增删改查助手、逐助手配模型/后端。
2. **本地小模型后端 `local-extract`（新）**：文件/视觉（以及音频）助手可切到 BYK 自带的本地提取层——图片 OCR（rapidocr-onnxruntime）、文档解析（pypdf/python-docx/python-pptx/openpyxl）、语音转写（faster-whisper），全程本地、不调云端、不需要 API key，且**禁止静默回落云端**。
3. **助手覆盖层**：新增 `lib/assistants.js`，设置页的改动写进 `<bykRoot>/byk/assistants.local.json`，运行时读取、立刻生效；未配置时行为与 v1.6.3 逐字段一致。
4. **逐助手模型配置**：`describeEffectiveRoute()` 统一回答「这个助手现在实际会用哪个模型/后端」。
5. 待批鬼影修复（镜像卡对 `manual-pending` 不再永久挂着）+ 附件默认分派规则 + `[byk 诊断]` 行改为配置项（默认关）。
6. Python 侧：`byk.cli` 新增 `extract` 子命令（配合 `local-extract` 后端）。

## 已知约束

- 宿主侧改动（新设置页、新后端）**必须完全重启 DSH Desktop** 才生效；客户端 bundle 刷新页面即可。
- 新增助手的工具参数 `enum` 在插件加载时定死：启动后新建的助手要重启一次才会出现在 `byk_role` 的参数枚举里（覆盖层本身已立刻生效）。
- `rollback.mjs` 的非 dry-run 真写盘路径仍未实测（回退可用 Copy-Item 覆盖）。
