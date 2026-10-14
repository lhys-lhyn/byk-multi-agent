/**
 * BYK Multi-Agent System DSH Plugin Types
 */

import { Service } from "@deepseek-ai/cordis";

/**
 * Assistant role definition
 */
export interface Role {
  id: string;
  name: string;
  color: string;
  description: string;
  model: string;
  provider: string;
  capabilities: string[];
}

/**
 * Subtask definition
 */
export interface Subtask {
  id: string;
  title: string;
  detail: string;
  role: string;
  depends_on: string[];
  status: "pending" | "executing" | "completed" | "failed";
  progress: number;
  result?: string;
  error?: string;
}

/**
 * Execution plan
 */
export interface ExecutionPlan {
  id: string;
  query: string;
  goal: string;
  subtasks: Subtask[];
  status: "pending" | "executing" | "completed" | "failed";
  created_at: string;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  subtask: Subtask;
  result?: string;
  error?: string;
  success: boolean;
}

/**
 * Multi-Agent Orchestrator Service
 */
export class MultiAgentOrchestrator extends Service {
  roles: Record<string, Role>;
  activeTasks: Map<string, ExecutionPlan>;
  userConfirmations: Map<string, boolean>;
  taskProgress: Map<string, any>;

  /**
   * Process user query
   * @param query - User query
   * @returns Processing result
   */
  processQuery(query: string): Promise<string>;

  /**
   * Create execution plan
   * @param query - User query
   * @returns Execution plan
   */
  createExecutionPlan(query: string): Promise<ExecutionPlan>;

  /**
   * Analyze user input
   * @param input - User input
   * @returns Analysis result
   */
  analyzeUserInput(input: string): {
    text: string;
    hasCode: boolean;
    hasImage: boolean;
    hasDocument: boolean;
    hasAudio: boolean;
    hasResearch: boolean;
    hasSearch: boolean;
    needsTaskPlanning: boolean;
  };

  /**
   * Show plan to user for confirmation
   * @param plan - Execution plan
   * @returns User confirmation
   */
  showPlanToUser(plan: ExecutionPlan): Promise<boolean>;

  /**
   * Execute plan with progress monitoring
   * @param plan - Execution plan
   * @returns Execution results
   */
  executePlanWithProgress(plan: ExecutionPlan): Promise<ExecutionResult[]>;

  /**
   * Execute subtask with progress monitoring
   * @param subtask - Subtask
   * @returns Execution result
   */
  executeSubtaskWithProgress(subtask: Subtask): Promise<string>;

  /**
   * Report progress to user
   * @param subtask - Subtask
   * @param message - Progress message
   */
  reportProgress(subtask: Subtask, message: string): void;

  /**
   * Summarize all assistant results
   * @param results - Execution results
   * @returns Summary result
   */
  summarizeResults(results: ExecutionResult[]): Promise<string>;

  /**
   * Get task progress
   * @param planId - Plan ID
   * @returns Task progress
   */
  getTaskProgress(planId: string): {
    plan_id: string;
    status: string;
    subtasks: {
      id: string;
      title: string;
      role: string;
      status: string;
      progress: number;
    }[];
  } | null;
}

/**
 * Plugin entry function
 */
export default function(ctx: any): void;