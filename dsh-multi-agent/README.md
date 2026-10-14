# BYK 多智能体协作系统 DSH 插件

这个插件为 DeepSeek Harness (DSH) 添加多智能体协作功能，让 DSH 能够在执行任务时调用多个专门的助手。

## 功能特性

- **任务识别与拆解**：自动分析用户任务，拆解为可独立执行的子任务
- **多助手并行执行**：为每个子任务指派最合适的助手角色，并行执行
- **结果汇总与整合**：汇总所有助手的输出，生成最终结果
- **七个专门助手**：
  - 任务助手 (task) - 任务识别与规划
  - 代码助手 (code) - 代码审查与执行
  - 视觉助手 (vision) - 图片与视频理解
  - 文件助手 (file) - 文档内容提取
  - 语音助手 (audio) - 语音转写与理解
  - 科研助手 (research) - 科研问题分析
  - 搜索助手 (search) - 全网资料检索

## 安装

### 1. 将插件添加到 DSH

```bash
cd C:\Projects\byk\dsh-multi-agent
dsh plugin --profile headless add @byk/dsh-multi-agent
```

### 2. 或者手动安装

将插件文件复制到 DSH 的插件目录：

```bash
# 复制插件文件
copy /Y "C:\Projects\byk\dsh-multi-agent\*" "%APPDATA%\com.yeagoo.dsh-desktop\harness\profiles\headless\node_modules\@byk\dsh-multi-agent\"
```

## 使用方法

### 1. 直接使用 DSH 命令

```bash
dsh --profile headless "请帮我创建一个 Python 脚本，计算斐波那契数列"
```

### 2. 通过 BYK 服务使用

启动 BYK 服务：

```bash
cd C:\Projects\byk
.\.venv\Scripts\python.exe -m byk --host 127.0.0.1 --port 8760
```

然后访问 http://127.0.0.1:8760 使用 Web 界面。

## 插件架构

### 核心组件

1. **MultiAgentOrchestrator** - 多智能体编排器服务
   - 负责任务分析、拆解、执行和汇总
   - 管理多个助手角色
   - 协调并行执行

2. **角色系统** - 七个专门的助手角色
   - 每个角色有特定的模型和能力
   - 根据任务类型自动指派角色

3. **任务计划** - 结构化的任务执行计划
   - 任务分析
   - 子任务列表
   - 角色指派
   - 执行顺序

### 工作流程

1. **任务接收**：接收用户输入的任务
2. **任务分析**：使用任务助手分析任务需求
3. **任务拆解**：将任务拆解为可独立执行的子任务
4. **角色指派**：为每个子任务指派最合适的助手角色
5. **并行执行**：多个助手并行执行子任务
6. **结果汇总**：汇总所有助手的输出，生成最终结果

## 配置

插件配置通过 `cordis.patch.yml` 文件进行：

```yaml
- id: system-prompt
  config:
    persona: >-
      你是 BYK 多智能体协作系统的编排器...

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    - id: multi-agent-orchestrator
      name: '@byk/dsh-multi-agent'
      inject: [agentDefaultModel, agents, sessions]
      config:
        task: !!js ctx.headlessStartup.task
```

## 开发

### 目录结构

```
dsh-multi-agent/
├── package.json          # 插件包配置
├── cordis.patch.yml      # Cordis 配置补丁
├── README.md             # 本文档
└── lib/
    ├── index.js          # 插件核心代码
    └── types/
        └── index.d.ts    # TypeScript 类型定义
```

### 添加新角色

在 `lib/index.js` 的 `ROLES` 对象中添加新角色：

```javascript
const ROLES = {
  // ... 现有角色
  newRole: {
    id: "newRole",
    name: "新助手",
    color: "#000000",
    description: "新助手的描述",
    model: "model-name",
    provider: "provider-name"
  }
};
```

### 修改任务处理流程

修改 `MultiAgentOrchestrator` 类中的方法：

- `planTask()` - 修改任务规划逻辑
- `executeSubtask()` - 修改子任务执行逻辑
- `summarizeResults()` - 修改结果汇总逻辑

## 故障排除

### 1. 插件加载失败

检查插件路径是否正确：

```bash
dsh --profile headless --dump-config
```

### 2. 角色模型不可用

检查模型配置：

```javascript
console.log(ROLES); // 查看所有角色配置
```

### 3. 任务执行超时

调整超时配置：

```javascript
const config = {
  timeout: 300000 // 5分钟超时
};
```

## 许可证

MIT License