/**
 * BYK 多智能体协作系统 DSH 插件类型定义
 */

import { Service } from "@deepseek-ai/cordis";

/**
 * 助手角色定义
 */
export interface Role {
  id: string;
  name: string;
  color: string;
  description: string;
  model: string;
  provider: string;
}

/**
 * 子任务定义
 */
export interface Subtask {
  id: string;
  title: string;
  role: string;
  detail: string;
  dependsOn?: string[];
  inputs?: string[];
  needsPrivilege?: boolean;
}

/**
 * 任务计划
 */
export interface TaskPlan {
  analysis: string;
  subtasks: Subtask[];
  executionOrder: string[];
}

/**
 * 子任务执行结果
 */
export interface SubtaskResult {
  subtask: Subtask;
  result?: string;
  error?: string;
  success: boolean;
}

/**
 * 多智能体编排器服务
 */
export class MultiAgentOrchestrator extends Service {
  roles: Record<string, Role>;
  activeTasks: Map<string, any>;

  /**
   * 处理用户任务
   * @param task - 用户任务描述
   * @returns 任务执行结果
   */
  processTask(task: string): Promise<string>;

  /**
   * 使用任务助手规划任务
   * @param task - 用户任务
   * @returns 任务计划
   */
  planTask(task: string): Promise<TaskPlan>;

  /**
   * 执行子任务
   * @param plan - 任务计划
   * @returns 子任务执行结果
   */
  executeSubtasks(plan: TaskPlan): Promise<SubtaskResult[]>;

  /**
   * 执行单个子任务
   * @param subtask - 子任务定义
   * @returns 子任务执行结果
   */
  executeSubtask(subtask: Subtask): Promise<string>;

  /**
   * 汇总所有子任务结果
   * @param results - 子任务执行结果
   * @returns 汇总结果
   */
  summarizeResults(results: SubtaskResult[]): Promise<string>;
}

/**
 * 插件入口函数
 */
export default function(ctx: any): void;