import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, ServerAgentDefinition } from '@bike4mind/agents';
import { getTextModelCost, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { usdToCredits } from '@bike4mind/utils';
import {
  ServerSubagentOrchestrator,
  type ServerSubagentTracker,
  type SubagentHandoffSignal,
  type ChildExecutionStatus,
} from './ServerSubagentOrchestrator';
import { runWithFakeTimers } from '../__tests__/helpers/fakeTimers';

/**
 * Minimal stubs. The orchestrator's background + dispatch paths are exercised
 * without actually constructing/running a ReActAgent - we only assert the
 * tracker callback contract (onStart + onLambdaDispatch + pollChildStatus).
 *
 * The synchronous in-process path is intentionally NOT tested here because it
 * constructs a real ReActAgent and would require mocking the LLM backend's
 * `complete` method end-to-end. Existing integration coverage exercises
 * that path; this file focuses on the dispatch-and-poll deltas.
 */

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
    // The orchestrator only touches these methods; cast covers any other Logger surface.
  } as unknown as Logger;
}

function makeLlm(model = 'claude-sonnet-4-6'): ICompletionBackend {
  return {
    currentModel: model,
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeAgentDef(overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name: 'researcher',
    description: 'Test agent',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a researcher. Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium',
    ...overrides,
  };
}

function makeTracker(overrides: Partial<ServerSubagentTracker> = {}): ServerSubagentTracker {
  return {
    onStart: vi.fn().mockResolvedValue('child-exec-id'),
    onComplete: vi.fn().mockResolvedValue(undefined),
    onFailure: vi.fn().mockResolvedValue(undefined),
    onLambdaDispatch: vi.fn().mockResolvedValue(undefined),
    pollChildStatus: vi.fn(),
    abortChild: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ServerSubagentOrchestrator', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('dispatchBackgroundAgent', () => {
    it('creates a background child and dispatches to Lambda, returning immediately', async () => {
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('bg-child-id'),
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
      });

      const result = await orchestrator.dispatchBackgroundAgent({
        task: 'Find weather data',
        agentDef: makeAgentDef(),
        thoroughness: 'medium',
      });

      expect(result.childExecutionId).toBe('bg-child-id');
      expect(result.agentName).toBe('researcher');
      expect(result.thoroughness).toBe('medium');

      expect(tracker.onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'researcher',
          task: 'Find weather data',
          isBackground: true,
          willDispatchToLambda: true,
        })
      );
      expect(tracker.onLambdaDispatch).toHaveBeenCalledWith({
        childExecutionId: 'bg-child-id',
        subagentConfig: expect.objectContaining({
          agentName: 'researcher',
          thoroughness: 'medium',
          maxIterations: 6,
        }),
        isBackground: true,
      });
      // INVARIANT: background dispatch returns BEFORE the agent runs, so
      // `onComplete`/`onFailure` must not be called from this Lambda. The
      // dispatched Lambda (`processSubagentDispatch`) owns the terminal write.
      expect(tracker.onComplete).not.toHaveBeenCalled();
      expect(tracker.onFailure).not.toHaveBeenCalled();
    });

    it('throws when tracker lacks required hooks', async () => {
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker: {
          onStart: vi.fn(),
          onComplete: vi.fn(),
          onFailure: vi.fn(),
          // onLambdaDispatch missing
        },
      });

      await expect(
        orchestrator.dispatchBackgroundAgent({
          task: 't',
          agentDef: makeAgentDef(),
        })
      ).rejects.toThrow(/background mode requires/);
    });

    it('uses agent default thoroughness when not specified', async () => {
      const tracker = makeTracker();
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
      });

      await orchestrator.dispatchBackgroundAgent({
        task: 't',
        agentDef: makeAgentDef({ defaultThoroughness: 'very_thorough' }),
      });

      expect(tracker.onLambdaDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          subagentConfig: expect.objectContaining({
            thoroughness: 'very_thorough',
            maxIterations: 12,
          }),
        })
      );
    });
  });

  describe('delegateToAgent — Lambda dispatch when parent time is short', () => {
    // Poll loop uses real setTimeout (POLL_INITIAL_MS=2000, exp backoff to 30s).
    // Fake timers + helper let us skip those waits without changing the orchestrator.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Advance by 35s each iter - enough to cover one POLL_MAX_MS (30s) backoff step.
    const POLL_TICK_MS = 35_000;

    it('dispatches to Lambda and polls when remaining time is less than thoroughness budget', async () => {
      // medium thoroughness needs 3 minutes; parent has only 2 minutes. -> dispatch.
      const remainingTimeMs = 2 * 60 * 1000;
      let pollCount = 0;
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('child-sync-id'),
        pollChildStatus: vi.fn().mockImplementation(async () => {
          pollCount += 1;
          if (pollCount < 2) {
            return { status: 'running' } satisfies ChildExecutionStatus;
          }
          return {
            status: 'completed',
            result: { answer: 'Done', iterations: 3, totalCredits: 42 },
          } satisfies ChildExecutionStatus;
        }),
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
        getRemainingTimeMs: () => remainingTimeMs,
      });

      const result = await runWithFakeTimers(
        orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
          thoroughness: 'medium',
        }),
        { advanceByMs: POLL_TICK_MS }
      );

      expect(tracker.onLambdaDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          childExecutionId: 'child-sync-id',
          isBackground: false,
        })
      );
      expect(tracker.pollChildStatus).toHaveBeenCalled();
      expect(result.finalAnswer).toBe('Done');
      expect(result.completionInfo.iterations).toBe(3);
      expect(result.completionInfo.totalCredits).toBe(42);
      // INVARIANT (load-bearing): the dispatch-and-poll path does NOT call
      // `tracker.onComplete`. The dispatched Lambda owns the terminal markComplete
      // write; the executor's tracker uses this invariant to skip a defensive
      // `findById` guard. If this assertion ever fails, the executor will
      // double-write and the comment at `subagentTracker.onComplete` is wrong.
      expect(tracker.onComplete).not.toHaveBeenCalled();
      expect(tracker.onFailure).not.toHaveBeenCalled();
    }, 30_000);

    it('sets handoffSignal and returns placeholder when parent deadline is reached', async () => {
      // Parent has 60s remaining; thoroughness budget is 3min. Will dispatch.
      // After dispatch, polling will see status=running while parent's remaining
      // time drops below the 90s buffer -> bail with handoff signal.
      let remaining = 60 * 1000;
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('child-handoff-id'),
        pollChildStatus: vi.fn().mockResolvedValue({ status: 'running' } satisfies ChildExecutionStatus),
      });

      const handoffSignal: SubagentHandoffSignal = {};
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
        getRemainingTimeMs: () => remaining,
        handoffSignal,
      });

      // Decay remaining so the orchestrator's deadline check trips on first poll.
      tracker.pollChildStatus = vi.fn().mockImplementation(async () => {
        remaining = 30 * 1000; // drop below 90s buffer
        return { status: 'running' } satisfies ChildExecutionStatus;
      });

      const result = await runWithFakeTimers(
        orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
          thoroughness: 'medium',
        }),
        { advanceByMs: POLL_TICK_MS }
      );

      expect(handoffSignal.awaitingSubagent).toEqual({
        childExecutionId: 'child-handoff-id',
        agentName: 'researcher',
      });
      expect(result.summary).toContain('Dispatched');
      expect(result.summary).toContain('child-handoff-id');
    });

    it('propagates abort: aborts child and throws when parent signal is aborted', async () => {
      // Remaining = 3 min: enough to be above the 90s deadline buffer (so polling
      // happens) but below the 4 min in-process-safety threshold for medium
      // thoroughness (budget 3min + PARENT_INPROCESS_SAFETY_MS 60s - so dispatch triggers).
      const remaining = 3 * 60 * 1000;
      const abortController = new AbortController();
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('child-abort-id'),
        pollChildStatus: vi.fn().mockImplementation(async () => {
          abortController.abort();
          return { status: 'running' } satisfies ChildExecutionStatus;
        }),
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        signal: abortController.signal,
        tracker,
        getRemainingTimeMs: () => remaining,
      });

      await expect(
        runWithFakeTimers(
          orchestrator.delegateToAgent({
            task: 't',
            agentDef: makeAgentDef(),
            thoroughness: 'medium',
          }),
          { advanceByMs: POLL_TICK_MS }
        )
      ).rejects.toThrow(/Parent aborted/);

      expect(tracker.abortChild).toHaveBeenCalledWith('child-abort-id');
    }, 30_000);

    it('throws cleanly when child execution disappears mid-poll', async () => {
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('ghost-child'),
        pollChildStatus: vi.fn().mockResolvedValue(null),
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
        // 3 min - above the 90s buffer (so polling happens) but below the
        // in-process safety threshold (so dispatch is taken).
        getRemainingTimeMs: () => 3 * 60 * 1000,
      });

      // No setTimeout fires before the null-status throw, so no fake-timer
      // advancement is needed.
      await expect(
        orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
          thoroughness: 'medium',
        })
      ).rejects.toThrow(/disappeared mid-poll/);
    });
  });

  describe('shouldDispatchToLambda heuristic', () => {
    it('does not dispatch when no remaining-time getter is provided', async () => {
      const tracker = makeTracker();
      // No `getRemainingTimeMs` -> in-process path. We can't fully run agent.run()
      // without mocking the LLM. Instead, assert onLambdaDispatch was NEVER called
      // by attempting to delegate and catching the unmocked agent.run() error.
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
      });

      await orchestrator
        .delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
          thoroughness: 'medium',
        })
        .catch(() => {
          // Expected - we don't mock the LLM, so agent.run() throws. The point is:
          // the dispatch path wasn't taken (otherwise pollChildStatus would have
          // been called instead).
        });

      expect(tracker.onLambdaDispatch).not.toHaveBeenCalled();
    });
  });

  describe('in-process credit fallback — cache-aware basis (#151)', () => {
    // Numeric-keyed tier: no explicit cache rates, so getTextModelCost derives them
    // from `input` via the cache multipliers (0.1x read, 1.25x write). Mirrors the
    // model shape used in delegateToAgent.test.ts.
    const MODEL_ID = 'claude-sonnet-4-6';
    const model: ModelInfo = {
      id: MODEL_ID,
      backend: 'bedrock',
      pricing: { 1_000_000: { input: 0.000003, output: 0.000015 } },
    } as unknown as ModelInfo;

    // Spy on the prototype so the real orchestrator (and ReActAgent constructor)
    // still run; only the network-bound `run()` is stubbed.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function stubAgentRun(completionInfo: AgentResult['completionInfo']): void {
      vi.spyOn(ReActAgent.prototype, 'run').mockResolvedValue({
        finalAnswer: 'done',
        steps: [],
        completionInfo,
      } satisfies AgentResult);
    }

    it('computes fallback totalCredits on the same cache-aware basis as the recorded cost', async () => {
      const inputTokens = 12_000;
      const outputTokens = 3_000;
      const cacheReadTokens = 40_000;
      const cacheWriteTokens = 5_000;
      // totalCredits absent -> the orchestrator's fallback computes it from tokens.
      stubAgentRun({
        totalTokens: inputTokens + outputTokens,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCacheReadTokens: cacheReadTokens,
        totalCacheWriteTokens: cacheWriteTokens,
        iterations: 3,
        toolCalls: 2,
        reachedMaxIterations: false,
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: MODEL_ID }),
        thoroughness: 'medium',
      });

      // The fallback credit sits on the cache-aware basis (input/output PLUS the
      // additive cache buckets) - the same basis as the costUsd recorded by
      // delegateToAgent's onCredits, so the two numbers in a usage-event row agree.
      expect(result.completionInfo.totalCredits).toBeCloseTo(
        usdToCredits(getTextModelCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)),
        10
      );
      // Strictly higher than the cache-blind value PR #132 would have produced: the
      // cache buckets are additive positive costs, so this is the ~+36% correction.
      expect(result.completionInfo.totalCredits!).toBeGreaterThan(
        usdToCredits(getTextModelCost(model, inputTokens, outputTokens))
      );
    });

    it('does not overwrite totalCredits when the subagent already reported them', async () => {
      stubAgentRun({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCacheReadTokens: 40_000,
        totalCacheWriteTokens: 5_000,
        totalCredits: 99,
        iterations: 3,
        toolCalls: 2,
        reachedMaxIterations: false,
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: MODEL_ID }),
        thoroughness: 'medium',
      });

      expect(result.completionInfo.totalCredits).toBe(99);
    });
  });
});
