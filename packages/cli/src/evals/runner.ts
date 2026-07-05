/**
 * Eval runner - executes tasks against a ReActAgent and reports outcomes.
 *
 * Backend-agnostic: pass any `ICompletionBackend` via `EvalContext.agent.llm`.
 * For mock-LLM unit testing, use a scripted backend. For real multi-provider
 * runs, wire up `ServerLlmBackend` (B4M's production proxy).
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ReActAgent } from '@bike4mind/agents';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { EvalTask, EvalResult, EvalReport, EvalContext, EvalMetrics } from './types.js';

/**
 * Per-task tool factory. Tools are sandbox-scoped (filesystem allowlist
 * passes the sandbox dir to `assertPathAllowed`), so each task needs a
 * fresh tool set bound to its own sandbox.
 *
 * Optional - when omitted, the runner uses `context.agent.tools` directly.
 * That path is for tests with mock LLMs that don't actually invoke tools.
 */
export type EvalToolFactory = (sandboxDir: string) => Promise<ICompletionOptionTools[]>;

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOTAL_TOKENS = 100_000;

const ZERO_METRICS: EvalMetrics = {
  totalTokens: 0,
  iterations: 0,
  toolCalls: 0,
  wallClockMs: 0,
  reachedMaxIterations: false,
  reachedMaxTotalTokens: false,
};

/**
 * Run a single task and return its result. Always cleans up the sandbox
 * directory, even on error.
 *
 * `toolFactory` produces per-sandbox tools. Omit it (mock-LLM tests) and
 * the runner falls back to `context.agent.tools`.
 */
export async function runEval(
  task: EvalTask,
  context: EvalContext,
  toolFactory?: EvalToolFactory
): Promise<EvalResult> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), `b4m-eval-${task.id}-`));

  try {
    if (task.setup) {
      await task.setup(sandboxDir);
    }

    const tools = toolFactory ? await toolFactory(sandboxDir) : context.agent.tools;

    const agent = new ReActAgent({
      ...context.agent,
      tools,
      maxIterations: task.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxTotalTokens: task.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
    });

    const prompt = typeof task.prompt === 'function' ? task.prompt(sandboxDir) : task.prompt;
    const start = Date.now();
    const result = await agent.run(prompt);
    const wallClockMs = Date.now() - start;

    const metrics: EvalMetrics = {
      totalTokens: result.completionInfo.totalTokens,
      iterations: result.completionInfo.iterations,
      toolCalls: result.completionInfo.toolCalls,
      wallClockMs,
      reachedMaxIterations: result.completionInfo.reachedMaxIterations,
      reachedMaxTotalTokens: result.completionInfo.reachedMaxTotalTokens ?? false,
    };

    const check = await task.check(result, sandboxDir);

    return {
      taskId: task.id,
      configLabel: context.configLabel,
      passed: check.passed,
      reason: check.reason,
      metrics,
    };
  } catch (error) {
    return {
      taskId: task.id,
      configLabel: context.configLabel,
      passed: false,
      reason: 'execution error',
      metrics: ZERO_METRICS,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Best-effort cleanup. Test failures should not leak temp dirs but we
    // also shouldn't mask real errors with a cleanup throw.
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run a sequence of tasks under one config and aggregate results.
 *
 * Sequential by design - different tasks may share filesystem regions
 * (cwd-relative paths in fixtures) and parallel runs make metrics noisier
 * (wall-clock contention, token-rate limits, etc.).
 */
export async function runEvalSuite(
  tasks: EvalTask[],
  context: EvalContext,
  toolFactory?: EvalToolFactory
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    const result = await runEval(task, context, toolFactory);
    results.push(result);
  }

  return {
    configLabel: context.configLabel,
    results,
    summary: summarize(results),
  };
}

function summarize(results: EvalResult[]) {
  return {
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed && !r.error).length,
    errored: results.filter(r => !!r.error).length,
    totalTokens: results.reduce((s, r) => s + r.metrics.totalTokens, 0),
    totalWallClockMs: results.reduce((s, r) => s + r.metrics.wallClockMs, 0),
  };
}
