/**
 * Evaluation framework types.
 *
 * Each `EvalTask` is a self-contained scenario that runs end-to-end through
 * a real `ReActAgent`. Tasks own their own sandbox setup and pass/fail
 * scoring so the runner stays generic - it just orchestrates execution
 * and aggregates metrics.
 *
 * The framework is intentionally backend-agnostic: callers pass in any
 * `ICompletionBackend` (mock for unit tests, `ServerLlmBackend` for real
 * multi-provider runs). The runner does not know or care which.
 */
import type { AgentResult, AgentContext } from '@bike4mind/agents';

/** A single task scenario. */
export interface EvalTask {
  /** Stable identifier (used in reports and to pick individual tasks for re-runs). */
  id: string;
  /** Human-readable summary of what the task exercises. */
  description: string;
  /**
   * The prompt sent to the agent. Function form receives the sandbox dir
   * so tasks can reference fixture paths without manual placeholder
   * substitution. String form is for prompts that don't need sandbox state.
   */
  prompt: string | ((sandboxDir: string) => string);
  /**
   * Optional fixture setup. Receives a fresh sandbox dir the task can
   * populate. The runner passes the same dir to `check`.
   */
  setup?: (sandboxDir: string) => Promise<void>;
  /**
   * Pass/fail scoring. Inspect the agent's result, the sandbox dir,
   * or both. Should be deterministic-ish - file existence, exact tool
   * call sequence, regex match on final answer, etc.
   */
  check: (result: AgentResult, sandboxDir: string) => Promise<EvalCheck>;
  /** Per-task iteration cap override (default: 50). */
  maxIterations?: number;
  /** Per-task cumulative token ceiling (default: 100_000). */
  maxTotalTokens?: number;
}

export interface EvalCheck {
  passed: boolean;
  /** One-line reason. Critical for understanding regressions across runs. */
  reason: string;
}

/** Outcome of a single (task x config) execution. */
export interface EvalResult {
  taskId: string;
  /** Identifies which configuration this run used (e.g. 'sonnet-4.6:current-prompt'). */
  configLabel: string;
  passed: boolean;
  reason: string;
  metrics: EvalMetrics;
  /**
   * Set when the agent or runner threw - distinct from a check failure,
   * which is a normal pass:false outcome.
   */
  error?: string;
}

export interface EvalMetrics {
  totalTokens: number;
  iterations: number;
  toolCalls: number;
  wallClockMs: number;
  reachedMaxIterations: boolean;
  reachedMaxTotalTokens: boolean;
}

/** Aggregated outcome of running multiple tasks under one config. */
export interface EvalReport {
  configLabel: string;
  results: EvalResult[];
  summary: EvalSummary;
}

export interface EvalSummary {
  /** Tasks where `check` returned passed:true. */
  passed: number;
  /** Tasks where `check` returned passed:false (no execution error). */
  failed: number;
  /** Tasks that threw (agent crash, timeout, etc.). */
  errored: number;
  totalTokens: number;
  totalWallClockMs: number;
}

/**
 * What the runner needs to execute a task. Separated from `AgentContext`
 * so the runner can override iteration/token caps per-task without
 * mutating the shared context object.
 */
export interface EvalContext {
  agent: Omit<AgentContext, 'maxIterations' | 'maxTotalTokens'>;
  configLabel: string;
}
