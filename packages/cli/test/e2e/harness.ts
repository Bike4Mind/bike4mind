/**
 * E2E harness for the B4M CLI agent loop.
 *
 * `runAgent()` constructs a `ReActAgent` with a scripted faux LLM backend,
 * runs it against a prompt, and returns a structured result that tests can
 * make assertions on (final answer, step list, captured events, tool-call
 * count, faux backend state).
 *
 * This is the regression net for the index.tsx decomposition (Q1a-Q1e).
 * It tests the agent-loop layer, which is where regressions would silently
 * land if a refactor breaks tool dispatch, event emission, or message
 * threading. Bootstrap concerns (auth, server-config, output formatting)
 * are deliberately excluded - those are themselves the subject of the
 * decomposition and will get their own test surface in Q1a.
 *
 * Pattern lifted from b4m-core/agents/src/ReActAgent.parallel.test.ts but
 * formalized so every e2e test uses one consistent shape.
 */

import { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, AgentStep } from '@bike4mind/agents';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { vi } from 'vitest';

import { createFauxBackend, type FauxBackend, type FauxScript } from './faux-llm.js';

export interface CapturedEvent {
  type: 'thought' | 'action' | 'observation' | 'complete' | 'error';
  step?: AgentStep;
  payload?: unknown;
  /** Monotonic order index in which this event was captured. */
  order: number;
}

export interface RunAgentOptions {
  /** User prompt fed to agent.run(). */
  prompt: string;
  /** LLM script - one turn per LLM call. */
  script: FauxScript;
  /** Tools available to the agent. Defaults to []. */
  tools?: ICompletionOptionTools[];
  /** System prompt. Defaults to a minimal placeholder. */
  systemPrompt?: string;
  /** Hard ceiling on agent iterations. Defaults to 10. */
  maxIterations?: number;
  /** ReActAgent run-options. Defaults to { parallelExecution: false }. */
  runOptions?: Parameters<ReActAgent['run']>[1];
}

export interface RunAgentResult {
  /** The final assistant answer the agent settled on. */
  finalAnswer: string;
  /** All AgentStep objects emitted during the run. */
  steps: AgentStep[];
  /** Number of tool calls the agent made. */
  toolCalls: number;
  /** Number of LLM-call iterations. */
  iterations: number;
  /** Captured event stream in emission order. */
  events: CapturedEvent[];
  /** Final state of the faux backend (callCount, callLog, etc.). */
  faux: FauxBackend;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** Raw AgentResult, in case tests need fields not surfaced above. */
  raw: AgentResult;
}

const DEFAULT_SYSTEM_PROMPT = 'You are a test assistant in an e2e harness. Follow instructions exactly.';

/**
 * Construct an agent with a faux backend and run it. Returns a structured
 * result for assertions. Throws on infrastructure errors (faux script
 * exhausted, etc.). Tests that want to assert on a thrown error from the
 * LLM should set `script.turns[N].error` and assert on `.run()` rejecting.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const faux = createFauxBackend(opts.script);

  const events: CapturedEvent[] = [];
  let order = 0;
  const capture = (type: CapturedEvent['type']) => (step: AgentStep) => {
    events.push({ type, step, order: order++ });
  };

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const agent = new ReActAgent({
    userId: 'e2e-test-user',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    llm: faux,
    model: faux.currentModel,
    tools: opts.tools ?? [],
    maxIterations: opts.maxIterations ?? 10,
    systemPrompt: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  });

  agent.on('thought', capture('thought'));
  agent.on('action', capture('action'));
  agent.on('observation', capture('observation'));
  agent.on('complete', capture('complete'));
  agent.on('error', capture('error'));

  const start = Date.now();
  let raw: AgentResult;
  try {
    raw = await agent.run(opts.prompt, opts.runOptions ?? { parallelExecution: false });
  } finally {
    agent.removeAllListeners();
  }
  const durationMs = Date.now() - start;

  return {
    finalAnswer: raw.finalAnswer,
    steps: raw.steps,
    toolCalls: raw.completionInfo.toolCalls,
    iterations: raw.completionInfo.iterations,
    events,
    faux,
    durationMs,
    raw,
  };
}

/**
 * Convenience helper for the most common case: a single-turn LLM response
 * with just text, no tools. Returns the final answer string.
 */
export async function runAgentText(prompt: string, response: string): Promise<string> {
  const result = await runAgent({
    prompt,
    script: { turns: [{ text: response }] },
  });
  return result.finalAnswer;
}
