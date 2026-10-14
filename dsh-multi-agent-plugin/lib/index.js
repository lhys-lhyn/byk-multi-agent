/**
 * BYK Multi-Agent System DSH Plugin
 *
 * STATUS / HONEST SCOPE (verified 2026-09-29):
 *   This plugin registers ONE cordis service, `multiAgentOrchestrator`, and
 *   logs the assistant roster. Nothing in DSH calls it yet: there is no hook
 *   into the message pipeline, and processQuery()/executeSubtaskWithProgress()
 *   below are simulations (setTimeout + console.log), not real model calls.
 *
 *   So it does NOT by itself turn DSH conversations into multi-agent runs. The
 *   working orchestrator for this project is the Python side (C:\Projects\byk\byk),
 *   driven through DSH's own subagent tools.
 *
 *   Do not describe this plugin as "the multi-agent system installed and working"
 *   until something actually consumes the service.
 */

/**
 * !! DO NOT add bare-specifier imports to this file. !!
 *
 * DSH loads profile plugins from their realpath. This package is installed as a
 * symlink (profiles/web/node_modules/@byk/dsh-multi-agent-plugin ->
 * C:\Projects\dsh\.dsh\plugins\byk-dsh-multi-agent-plugin), so Node resolves
 * imports starting from the plugin directory, where @deepseek-ai/cordis is NOT
 * installed. It used to do `import { Service } from "@deepseek-ai/cordis"`,
 * which threw ERR_MODULE_NOT_FOUND, failed the whole plugin tree, and made
 * DSH Desktop crash-loop on every restart.
 *
 * Cordis services are available through the `ctx` handed to the apply function.
 */

/**
 * Assistant roles definition
 */
const ROLES = {
  task: {
    id: "task",
    name: "任务助手",
    color: "#a78bfa",
    description: "识别用户诉求中的任务，拆解为子任务并指派角色",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["任务识别", "任务拆解", "角色指派"]
  },
  code: {
    id: "code",
    name: "代码助手",
    color: "#60a5fa",
    description: "代码审查、缺陷排查、执行命令、构建与部署",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["代码审查", "执行命令", "构建部署", "调试排错"]
  },
  vision: {
    id: "vision",
    name: "视觉助手",
    color: "#22d3ee",
    description: "理解图片与视频内容",
    model: "mimo-v2.6",
    provider: "xiaomi",
    capabilities: ["图片识别", "视频理解", "OCR识别"]
  },
  file: {
    id: "file",
    name: "文件助手",
    color: "#fbbf24",
    description: "提取并结构化 Word / PPT / PDF / Excel 内容",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["文档解析", "内容提取", "格式转换"]
  },
  audio: {
    id: "audio",
    name: "语音助手",
    color: "#f472b6",
    description: "语音转写内容的整理与理解",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["语音转写", "内容整理", "时间轴标注"]
  },
  research: {
    id: "research",
    name: "科研助手",
    color: "#34d399",
    description: "科研问题分析、文献检索与研究成果综述",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["文献检索", "论文分析", "研究综述"]
  },
  search: {
    id: "search",
    name: "搜索助手",
    color: "#fb923c",
    description: "检索与问题相关的资料并汇总出可追溯的信息",
    model: "deepseek-v4-flash",
    provider: "deepseek-official",
    capabilities: ["网络搜索", "信息汇总", "来源追溯"]
  }
};

/**
 * Multi-Agent Orchestrator Service
 */
class MultiAgentOrchestrator {
  static inject = ["agentDefaultModel", "agents", "sessions"];

  constructor(ctx) {
    this.ctx = ctx;
    this.roles = ROLES;
    this.activeTasks = new Map();
    this.userConfirmations = new Map();
    this.taskProgress = new Map();
  }

  /**
   * Process user query - main entry point
   * @param {string} query - User query
   * @returns {Promise<string>} - Processing result
   */
  async processQuery(query) {
    console.log(`[BYK] Received user query: ${query}`);
    
    try {
      // 1. Analyze user input and create execution plan
      const plan = await this.createExecutionPlan(query);
      
      // 2. Show plan to user for confirmation
      const confirmed = await this.showPlanToUser(plan);
      
      if (!confirmed) {
        return "任务已取消或需要修改";
      }
      
      // 3. After user confirmation, execute the plan
      const results = await this.executePlanWithProgress(plan);
      
      // 4. Summarize results
      const summary = await this.summarizeResults(results);
      
      return summary;
    } catch (error) {
      console.error(`[BYK] Task processing failed: ${error.message}`);
      return `任务处理失败: ${error.message}`;
    }
  }

  /**
   * Create execution plan
   * @param {string} query - User query
   * @returns {Promise<Object>} - Execution plan
   */
  async createExecutionPlan(query) {
    console.log(`[BYK] Task assistant analyzing query...`);
    
    // Analyze user input to determine which assistants are needed
    const analysis = this.analyzeUserInput(query);
    
    // Create execution plan
    const plan = {
      id: `plan_${Date.now()}`,
      query: query,
      goal: `处理用户 query: ${query}`,
      subtasks: [],
      status: "pending",
      created_at: new Date().toISOString()
    };
    
    // Create subtasks based on analysis
    if (analysis.needsTaskPlanning) {
      plan.subtasks.push({
        id: "st_1",
        title: "分析任务需求",
        detail: `分析用户 query 的具体需求: ${query}`,
        role: "task",
        depends_on: [],
        status: "pending",
        progress: 0
      });
    }
    
    if (analysis.hasCode) {
      plan.subtasks.push({
        id: "st_2",
        title: "处理代码任务",
        detail: `处理与代码相关的任务: ${query}`,
        role: "code",
        depends_on: ["st_1"],
        status: "pending",
        progress: 0
      });
    }
    
    if (analysis.hasImage || analysis.hasDocument) {
      plan.subtasks.push({
        id: "st_3",
        title: "处理文档/图片任务",
        detail: `处理文档或图片相关的任务: ${query}`,
        role: "file",
        depends_on: ["st_1"],
        status: "pending",
        progress: 0
      });
    }
    
    if (analysis.hasAudio) {
      plan.subtasks.push({
        id: "st_4",
        title: "处理语音任务",
        detail: `处理语音相关的任务: ${query}`,
        role: "audio",
        depends_on: ["st_1"],
        status: "pending",
        progress: 0
      });
    }
    
    if (analysis.hasResearch) {
      plan.subtasks.push({
        id: "st_5",
        title: "处理科研任务",
        detail: `处理科研相关的任务: ${query}`,
        role: "research",
        depends_on: ["st_1"],
        status: "pending",
        progress: 0
      });
    }
    
    if (analysis.hasSearch) {
      plan.subtasks.push({
        id: "st_6",
        title: "处理搜索任务",
        detail: `处理搜索相关的任务: ${query}`,
        role: "search",
        depends_on: ["st_1"],
        status: "pending",
        progress: 0
      });
    }
    
    // Store the plan
    this.activeTasks.set(plan.id, plan);
    
    return plan;
  }

  /**
   * Analyze user input
   * @param {string} input - User input
   * @returns {Object} - Analysis result
   */
  analyzeUserInput(input) {
    const analysis = {
      text: input,
      hasCode: this.detectCodeContent(input),
      hasImage: this.detectImageContent(input),
      hasDocument: this.detectDocumentContent(input),
      hasAudio: this.detectAudioContent(input),
      hasResearch: this.detectResearchContent(input),
      hasSearch: this.detectSearchContent(input),
      needsTaskPlanning: true
    };
    
    return analysis;
  }

  /**
   * Detect code content
   */
  detectCodeContent(input) {
    const codeIndicators = [
      /code/i, /script/i, /程序/i, /代码/i, /函数/i, /算法/i,
      /debug/i, /bug/i, /error/i, /错误/i, /异常/i,
      /deploy/i, /部署/i, /build/i, /构建/i,
      /review/i, /审查/i
    ];
    
    return codeIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Detect image content
   */
  detectImageContent(input) {
    const imageIndicators = [
      /image/i, /图片/i, /图像/i, /照片/i, /截图/i,
      /video/i, /视频/i, /影片/i,
      /see/i, /看/i, /识别/i, /理解/i
    ];
    
    return imageIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Detect document content
   */
  detectDocumentContent(input) {
    const documentIndicators = [
      /document/i, /文档/i, /文件/i,
      /word/i, /pdf/i, /ppt/i, /excel/i,
      /read/i, /读取/i, /提取/i
    ];
    
    return documentIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Detect audio content
   */
  detectAudioContent(input) {
    const audioIndicators = [
      /audio/i, /音频/i, /语音/i, /录音/i,
      /transcribe/i, /转写/i, /识别语音/i
    ];
    
    return audioIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Detect research content
   */
  detectResearchContent(input) {
    const researchIndicators = [
      /research/i, /科研/i, /研究/i, /论文/i, /文献/i,
      /paper/i, /journal/i, /期刊/i,
      /hypothesis/i, /假设/i, /实验/i
    ];
    
    return researchIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Detect search content
   */
  detectSearchContent(input) {
    const searchIndicators = [
      /search/i, /搜索/i, /查找/i, /检索/i,
      /find/i, /look for/i, /info/i, /信息/i
    ];
    
    return searchIndicators.some(pattern => pattern.test(input));
  }

  /**
   * Show plan to user for confirmation
   * @param {Object} plan - Execution plan
   * @returns {Promise<boolean>} - User confirmation
   */
  async showPlanToUser(plan) {
    console.log(`[BYK] Showing plan to user for confirmation...`);
    
    // Generate plan confirmation message
    let confirmationMessage = `## 执行计划确认\n\n`;
    confirmationMessage += `**目标**: ${plan.goal}\n\n`;
    confirmationMessage += `**子任务列表**:\n`;
    
    for (const subtask of plan.subtasks) {
      const role = this.roles[subtask.role];
      confirmationMessage += `1. **${subtask.title}** (${role.name})\n`;
      confirmationMessage += `   - 描述: ${subtask.detail}\n`;
      confirmationMessage += `   - 依赖: ${subtask.depends_on.length > 0 ? subtask.depends_on.join(', ') : '无'}\n\n`;
    }
    
    confirmationMessage += `请确认是否执行此计划？(是/否)`;
    
    console.log(`[BYK] Plan confirmation message:\n${confirmationMessage}`);
    
    // In a real implementation, this would wait for user input
    // For now, we assume the user confirms
    return true;
  }

  /**
   * Execute plan with progress monitoring
   * @param {Object} plan - Execution plan
   * @returns {Promise<Array>} - Execution results
   */
  async executePlanWithProgress(plan) {
    console.log(`[BYK] Starting plan execution...`);
    
    const results = [];
    
    // Update plan status
    plan.status = "executing";
    
    // Execute each subtask
    for (const subtask of plan.subtasks) {
      try {
        // Update subtask status
        subtask.status = "executing";
        subtask.progress = 0;
        
        // Report progress to user
        this.reportProgress(subtask, "开始执行");
        
        // Execute subtask
        const result = await this.executeSubtaskWithProgress(subtask);
        
        // Update subtask status
        subtask.status = "completed";
        subtask.progress = 100;
        subtask.result = result;
        
        // Report completion to user
        this.reportProgress(subtask, "执行完成");
        
        results.push({
          subtask,
          result,
          success: true
        });
      } catch (error) {
        // Update subtask status
        subtask.status = "failed";
        subtask.error = error.message;
        
        // Report failure to user
        this.reportProgress(subtask, `执行失败: ${error.message}`);
        
        results.push({
          subtask,
          error: error.message,
          success: false
        });
      }
    }
    
    // Update plan status
    plan.status = "completed";
    
    return results;
  }

  /**
   * Execute subtask with progress monitoring
   * @param {Object} subtask - Subtask
   * @returns {Promise<string>} - Execution result
   */
  async executeSubtaskWithProgress(subtask) {
    const role = this.roles[subtask.role];
    
    console.log(`[BYK] Executing subtask: ${subtask.title} (${role.name})`);
    
    // Simulate execution process
    for (let progress = 0; progress <= 100; progress += 20) {
      subtask.progress = progress;
      this.reportProgress(subtask, `执行中... ${progress}%`);
      
      // Simulate execution time
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // In a real implementation, this would call the actual assistant
    return `${role.name} 已完成任务: ${subtask.title}`;
  }

  /**
   * Report progress to user
   * @param {Object} subtask - Subtask
   * @param {string} message - Progress message
   */
  reportProgress(subtask, message) {
    const role = this.roles[subtask.role];
    const progressMessage = `[${role.name}] ${subtask.title}: ${message} (${subtask.progress}%)`;
    
    console.log(`[BYK] Progress report: ${progressMessage}`);
    
    // In a real implementation, this would send SSE events or WebSocket messages
  }

  /**
   * Summarize all assistant results
   * @param {Array} results - Execution results
   * @returns {Promise<string>} - Summary result
   */
  async summarizeResults(results) {
    let summary = "## 任务执行结果总结\n\n";
    
    const successfulTasks = results.filter(r => r.success);
    const failedTasks = results.filter(r => !r.success);
    
    summary += `**执行统计**:\n`;
    summary += `- 成功: ${successfulTasks.length} 个\n`;
    summary += `- 失败: ${failedTasks.length} 个\n`;
    summary += `- 总计: ${results.length} 个\n\n`;
    
    if (successfulTasks.length > 0) {
      summary += `**成功任务**:\n`;
      for (const result of successfulTasks) {
        const role = this.roles[result.subtask.role];
        summary += `✅ **${role.name}** - ${result.subtask.title}\n`;
        summary += `   结果: ${result.result}\n\n`;
      }
    }
    
    if (failedTasks.length > 0) {
      summary += `**失败任务**:\n`;
      for (const result of failedTasks) {
        const role = this.roles[result.subtask.role];
        summary += `❌ **${role.name}** - ${result.subtask.title}\n`;
        summary += `   错误: ${result.error}\n\n`;
      }
    }
    
    return summary;
  }

  /**
   * Get task progress
   * @param {string} planId - Plan ID
   * @returns {Object} - Task progress
   */
  getTaskProgress(planId) {
    const plan = this.activeTasks.get(planId);
    if (!plan) {
      return null;
    }
    
    return {
      plan_id: plan.id,
      status: plan.status,
      subtasks: plan.subtasks.map(subtask => ({
        id: subtask.id,
        title: subtask.title,
        role: subtask.role,
        status: subtask.status,
        progress: subtask.progress
      }))
    };
  }
}

/**
 * Plugin entry
 *
 * Deliberately defensive: a plugin that throws while being applied takes the
 * whole DSH plugin tree (and therefore the app boot) down with it. This plugin
 * registers a service and nothing else, so a failure here must never be fatal.
 */
export default function apply(ctx) {
  try {
    ctx.provide("multiAgentOrchestrator", new MultiAgentOrchestrator(ctx));
    console.log("[BYK] Multi-Agent System plugin loaded");
    console.log("[BYK] Available assistants:");
    Object.values(ROLES).forEach(role => {
      console.log(`  - ${role.id}: ${role.name} - ${role.description}`);
    });
  } catch (error) {
    console.error("[BYK] plugin init failed (non-fatal):", error?.message ?? error);
  }
}