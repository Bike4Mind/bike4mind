import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, ServerAgentDefinition } from '@bike4mind/agents';
import {
  CREDITS_PER_USD_COST,
  ForbiddenError,
  getTextModelCost,
  getTurnsCost,
  type ModelInfo,
} from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import {
  ServerSubagentOrchestrator,
  spentResultOf,
  type ServerSubagentTracker,
  type SubagentHandoffSignal,
  type ChildExecutionStatus,
} from './ServerSubagentOrchestrator';
import { runWithFakeTimers } from '../__tests__/helpers/fakeTimers';

// The real stochastic rounding, with its draw pinned so the fallback charge is assertable.
const { settlementDraw } = vi.hoisted(() => ({ settlementDraw: vi.fn(() => 0.5) }));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => settlementDraw()),
  };
});
beforeEach(() => {
  settlementDraw.mockReturnValue(0.5);
});

// What a draw of 0.5 settles for an exact USD cost: the floor, plus 1 when the fraction exceeds the draw.
const settledAtHalf = (usd: number) => {
  const raw = usd * CREDITS_PER_USD_COST;
  return Math.floor(raw) + (0.5 < raw - Math.floor(raw) ? 1 : 0);
};

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

  it.each(['execution-model', 'other-model'])(
    'applies substitute identity only to its execution model (%s)',
    async effectiveModel => {
      const llm = makeLlm(effectiveModel);
      const run = vi.spyOn(ReActAgent.prototype, 'run').mockImplementation(async function (this: ReActAgent) {
        await this.completeText('Identify yourself');
        return {
          finalAnswer: 'done',
          steps: [],
          completionInfo: {
            totalTokens: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 1,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        } satisfies AgentResult;
      });
      try {
        const orchestrator = new ServerSubagentOrchestrator({
          userId: 'u1',
          llm,
          logger: makeLogger(),
          parentTools: [],
          substituteIdentity: {
            substituteId: 'execution-model',
            identityId: 'requested-model',
            displayName: 'Requested',
          },
        });
        await orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: effectiveModel }) });

        const options = vi.mocked(llm.complete).mock.calls[0]?.[2];
        if (effectiveModel === 'execution-model') {
          expect(options).toMatchObject({ modelIdentityId: 'requested-model', modelDisplayName: 'Requested' });
        } else {
          expect(options).not.toHaveProperty('modelIdentityId');
          expect(options).not.toHaveProperty('modelDisplayName');
        }
      } finally {
        run.mockRestore();
      }
    }
  );

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

  describe('delegateToAgent - model admission', () => {
    const GATED_ID = 'claude-opus-5';

    it('refuses a built-in agent whose pinned model the user is not admitted to, before any work', async () => {
      const llm = makeLlm();
      const tracker = makeTracker();
      const resolveBackend = vi.fn((modelId: string) => makeLlm(modelId));
      const assert = vi.fn(async (modelId: string) => {
        if (modelId === GATED_ID) throw new Error(`Model "${modelId}" is not accessible and no fallback available`);
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm,
        logger: makeLogger(),
        parentTools: [],
        tracker,
        resolveBackend,
        modelAdmission: { assert },
      });

      await expect(
        orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: GATED_ID }) })
      ).rejects.toThrow(`Model "${GATED_ID}" is not accessible`);

      expect(assert).toHaveBeenCalledWith(GATED_ID);
      expect(llm.complete).not.toHaveBeenCalled();
      expect(tracker.onStart).not.toHaveBeenCalled();
    });

    describe('free-tier refusal', () => {
      const PAID_ID = 'claude-opus-5';
      const FREE_ID = 'claude-haiku-5-5';
      const PARENT_ID = 'parent-model';

      const assertRefusingPaid = () =>
        vi.fn(async (modelId: string) => {
          if (modelId === PAID_ID) {
            throw new ForbiddenError(`Model "${modelId}" requires a paid plan`, {
              errorCode: 'model_requires_subscription',
            });
          }
        });

      const makeOrchestrator = (assert: (modelId: string) => Promise<void>, serviceable: string[]) => {
        const resolveBackend = vi.fn((modelId: string) => (serviceable.includes(modelId) ? makeLlm(modelId) : null));
        const orchestrator = new ServerSubagentOrchestrator({
          userId: 'u1',
          llm: makeLlm(PARENT_ID),
          logger: makeLogger(),
          parentTools: [],
          resolveBackend,
          modelAdmission: { assert },
        });
        return { orchestrator, resolveBackend };
      };

      beforeEach(() => {
        vi.spyOn(ReActAgent.prototype, 'run').mockResolvedValue({
          finalAnswer: 'done',
          steps: [],
          completionInfo: {
            totalTokens: 100,
            totalInputTokens: 80,
            totalOutputTokens: 20,
            totalCredits: 1,
            iterations: 1,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        } satisfies AgentResult);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('runs on an admitted fallback instead of failing when the pinned model needs a paid plan', async () => {
        const { orchestrator, resolveBackend } = makeOrchestrator(assertRefusingPaid(), [PAID_ID, FREE_ID]);

        const result = await orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef({ model: PAID_ID, fallbackModels: [FREE_ID] }),
          thoroughness: 'medium',
        });

        expect(resolveBackend).toHaveBeenCalledWith(FREE_ID);
        expect(resolveBackend).not.toHaveBeenCalledWith(PAID_ID);
        expect(result.model).toBe(FREE_ID);
      });

      it("runs on the parent's model when no fallback is admitted", async () => {
        const { orchestrator, resolveBackend } = makeOrchestrator(assertRefusingPaid(), [PAID_ID]);

        const result = await orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef({ model: PAID_ID, fallbackModels: [PAID_ID] }),
          thoroughness: 'medium',
        });

        expect(resolveBackend).not.toHaveBeenCalled();
        expect(result.model).toBe(PARENT_ID);
      });

      it('still rejects when the pinned model is refused for any reason other than the free-tier gate', async () => {
        const assert = vi.fn(async (modelId: string) => {
          // A ForbiddenError without the subscription errorCode pins that only that code degrades.
          if (modelId === PAID_ID) {
            throw new ForbiddenError(`Model "${modelId}" is not accessible and no fallback available`);
          }
        });
        const { orchestrator } = makeOrchestrator(assert, [PAID_ID, FREE_ID]);

        await expect(
          orchestrator.delegateToAgent({
            task: 't',
            agentDef: makeAgentDef({ model: PAID_ID, fallbackModels: [FREE_ID] }),
            thoroughness: 'medium',
          })
        ).rejects.toThrow(`Model "${PAID_ID}" is not accessible`);
      });
    });
  });

  describe('delegateToAgent \u2014 per-member credit cap gate', () => {
    it('throws before any tracker/LLM work when checkMemberCreditCap returns true', async () => {
      const llm = makeLlm();
      const tracker = makeTracker();

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm,
        logger: makeLogger(),
        parentTools: [],
        tracker,
        checkMemberCreditCap: () => true,
      });

      await expect(
        orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
        })
      ).rejects.toThrow(/credit limit reached/);

      // The refusal must cost nothing: no LLM call and no tracker lifecycle event.
      expect(llm.complete).not.toHaveBeenCalled();
      expect(tracker.onStart).not.toHaveBeenCalled();
    });

    it('proceeds through Lambda dispatch as normal when checkMemberCreditCap returns false', async () => {
      vi.useFakeTimers();
      const remainingTimeMs = 2 * 60 * 1000; // forces dispatch-and-poll, same as the test below
      const tracker = makeTracker({
        onStart: vi.fn().mockResolvedValue('child-not-capped-id'),
        pollChildStatus: vi.fn().mockResolvedValue({
          status: 'completed',
          result: { answer: 'Done', iterations: 1, totalCredits: 5 },
        } satisfies ChildExecutionStatus),
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(),
        logger: makeLogger(),
        parentTools: [],
        tracker,
        getRemainingTimeMs: () => remainingTimeMs,
        checkMemberCreditCap: () => false,
      });

      const result = await runWithFakeTimers(
        orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef(),
          thoroughness: 'medium',
        }),
        { advanceByMs: 35_000 }
      );

      expect(result.finalAnswer).toBe('Done');
      expect(tracker.onStart).toHaveBeenCalled();
    }, 30_000);
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

    it.each([0, undefined])(
      'reports totalCredits as undefined when the dispatched child persisted %s',
      async persistedCredits => {
        const tracker = makeTracker({
          onStart: vi.fn().mockResolvedValue('child-zero-id'),
          pollChildStatus: vi.fn().mockResolvedValue({
            status: 'completed',
            result: { answer: 'Done', iterations: 1, totalCredits: persistedCredits },
          } satisfies ChildExecutionStatus),
        });

        const orchestrator = new ServerSubagentOrchestrator({
          userId: 'u1',
          llm: makeLlm(),
          logger: makeLogger(),
          parentTools: [],
          tracker,
          getRemainingTimeMs: () => 2 * 60 * 1000,
        });

        const result = await runWithFakeTimers(
          orchestrator.delegateToAgent({
            task: 't',
            agentDef: makeAgentDef(),
            thoroughness: 'medium',
          }),
          { advanceByMs: POLL_TICK_MS }
        );

        expect(result.finalAnswer).toBe('Done');
        // A persisted 0 is indistinguishable from "not reported", so it must not reach
        // delegateToAgent's onCredits gate (which would write an all-zero usage event).
        expect(result.completionInfo.totalCredits).toBeUndefined();
      },
      30_000
    );

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
      // The handoff Lambda runs the child, so the delegating tool must not bill this placeholder.
      expect(result.billedByTracker).toBe(true);
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

    // Long-context tiers: each request below sits under 200K, the run's totals do not.
    const tiered: ModelInfo = {
      id: MODEL_ID,
      backend: 'bedrock',
      pricing: {
        200_000: { input: 0.000003, output: 0.000015 },
        1_000_000: { input: 0.000006, output: 0.0000225 },
      },
    } as unknown as ModelInfo;
    const turnUsage = [
      { inputTokens: 150_000, outputTokens: 500 },
      { inputTokens: 151_000, outputTokens: 700 },
    ];

    it('computes fallback totalCredits per request when the agent reports per-request usage', async () => {
      stubAgentRun({
        totalTokens: 302_200,
        totalInputTokens: 301_000,
        totalOutputTokens: 1_200,
        turnUsage,
        iterations: 2,
        toolCalls: 1,
        reachedMaxIterations: false,
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [tiered],
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: MODEL_ID }),
        thoroughness: 'medium',
      });

      expect(result.completionInfo.totalCredits).toBe(settledAtHalf(getTurnsCost(tiered, turnUsage)));
      expect(result.completionInfo.totalCredits!).toBeLessThan(settledAtHalf(getTextModelCost(tiered, 301_000, 1_200)));
    });

    it('prices a cached long prompt in the totals fallback on the tier its whole prompt falls in', async () => {
      stubAgentRun({
        totalTokens: 210_100,
        totalInputTokens: 20_000,
        totalOutputTokens: 100,
        totalCacheReadTokens: 190_000,
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [tiered],
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: MODEL_ID }),
        thoroughness: 'medium',
      });

      // 210K prompt: the >200K rates, though the uncached 20K alone sits under the threshold.
      expect(result.completionInfo.totalCredits).toBe(
        settledAtHalf(20_000 * 0.000006 + 190_000 * 0.000006 * 0.1 + 100 * 0.0000225)
      );
    });

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
      expect(result.completionInfo.totalCredits).toBe(
        settledAtHalf(getTextModelCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens))
      );
      // Strictly higher than the cache-blind value PR #132 would have produced: the
      // cache buckets are additive positive costs, so this is the ~+36% correction.
      expect(result.completionInfo.totalCredits!).toBeGreaterThan(
        settledAtHalf(getTextModelCost(model, inputTokens, outputTokens))
      );
    });

    describe('final charge rounding', () => {
      // 12K input tokens at $4.375e-7 each: exactly 10.5 credits at the default rate.
      const halfCreditModel: ModelInfo = {
        id: MODEL_ID,
        backend: 'bedrock',
        pricing: { 1_000_000: { input: 10.5 / CREDITS_PER_USD_COST / 12_000, output: 0 } },
      } as unknown as ModelInfo;

      const delegateWith = async (m: ModelInfo, totalInputTokens: number) => {
        stubAgentRun({
          totalTokens: totalInputTokens,
          totalInputTokens,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        });
        const orchestrator = new ServerSubagentOrchestrator({
          userId: 'u1',
          llm: makeLlm(MODEL_ID),
          logger: makeLogger(),
          parentTools: [],
          availableModels: [m],
        });
        return orchestrator.delegateToAgent({
          task: 't',
          agentDef: makeAgentDef({ model: MODEL_ID }),
          thoroughness: 'medium',
        });
      };

      it.each([
        [0.25, 11],
        [0.75, 10],
      ])('charges N or N+1 for a cost of N + 0.5 credits (draw %s -> %s)', async (draw, expected) => {
        settlementDraw.mockReturnValue(draw);

        const result = await delegateWith(halfCreditModel, 12_000);

        expect(result.completionInfo.totalCredits).toBe(expected);
      });

      it('can charge 0 for a tiny cost instead of a 1-credit minimum', async () => {
        settlementDraw.mockReturnValue(0.5);

        const result = await delegateWith(model, 1);

        expect(result.completionInfo.totalCredits).toBe(0);
      });
    });

    it('warns and leaves totalCredits unset when the model is not in availableModels (#152)', async () => {
      stubAgentRun({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        iterations: 3,
        toolCalls: 2,
        reachedMaxIterations: false,
      });

      const logger = makeLogger();
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger,
        parentTools: [],
        // availableModels present but does not contain MODEL_ID -> fallback misses.
        availableModels: [],
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: MODEL_ID }),
        thoroughness: 'medium',
      });

      expect(result.completionInfo.totalCredits).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(MODEL_ID));
    });

    it.each([0, 99])('preserves a previously settled charge of %s', async reportedCredits => {
      stubAgentRun({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCacheReadTokens: 40_000,
        totalCacheWriteTokens: 5_000,
        totalCredits: reportedCredits,
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

      expect(result.completionInfo.totalCredits).toBe(reportedCredits);
    });

    it('prices the tokens a timed-out run spent, so a timeout is not free', async () => {
      const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
      vi.spyOn(ReActAgent.prototype, 'run').mockRejectedValue(abort);
      vi.spyOn(ReActAgent.prototype, 'toCheckpoint').mockReturnValue({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        turnUsage: [],
        totalCredits: 0,
      } as unknown as ReturnType<ReActAgent['toCheckpoint']>);

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

      expect(result.summary).toContain('Partial results');
      expect(result.completionInfo.totalCredits).toBeCloseTo(
        settledAtHalf(getTextModelCost(model, 12_000, 3_000, 0, 0)),
        10
      );
    });

    it('carries the priced tokens a failed run spent on the error, so its payer can be charged', async () => {
      vi.spyOn(ReActAgent.prototype, 'run').mockRejectedValue(new Error('provider 500'));
      vi.spyOn(ReActAgent.prototype, 'toCheckpoint').mockReturnValue({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        turnUsage: [],
        totalCredits: 0,
      } as unknown as ReturnType<ReActAgent['toCheckpoint']>);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
      });

      const error = await orchestrator
        .delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: MODEL_ID }), thoroughness: 'medium' })
        .catch((err: unknown) => err);

      expect((error as Error).message).toBe('provider 500');
      expect(spentResultOf(error)?.completionInfo.totalCredits).toBeCloseTo(
        settledAtHalf(getTextModelCost(model, 12_000, 3_000, 0, 0)),
        10
      );
    });

    it('hands the tracker the priced usage a failed run spent, so a tracked run is still billed', async () => {
      vi.spyOn(ReActAgent.prototype, 'run').mockRejectedValue(new Error('provider 500'));
      vi.spyOn(ReActAgent.prototype, 'toCheckpoint').mockReturnValue({
        totalTokens: 15_000,
        totalInputTokens: 12_000,
        totalOutputTokens: 3_000,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        turnUsage: [],
        totalCredits: 0,
      } as unknown as ReturnType<ReActAgent['toCheckpoint']>);
      const tracker = makeTracker();

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
        tracker,
      });

      await expect(
        orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: MODEL_ID }), thoroughness: 'medium' })
      ).rejects.toThrow('provider 500');

      expect(tracker.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          childExecutionId: 'child-exec-id',
          isTimeout: false,
          partialResult: expect.objectContaining({
            completionInfo: expect.objectContaining({
              totalCredits: expect.closeTo(settledAtHalf(getTextModelCost(model, 12_000, 3_000, 0, 0)), 10),
            }),
          }),
        })
      );
    });

    const ranInfo: AgentResult['completionInfo'] = {
      totalTokens: 15,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCredits: 7,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    };

    // The tracker's onComplete bills a tracked run; the delegating tool bills everything else.
    it('marks a tracked run as billed by its tracker', async () => {
      stubAgentRun(ranInfo);
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
        tracker: makeTracker(),
      });

      const result = await orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: MODEL_ID }) });

      expect(result.billedByTracker).toBe(true);
    });

    it('leaves a run untracked when tracker.onStart fails, so its caller bills it', async () => {
      stubAgentRun(ranInfo);
      const tracker = makeTracker({ onStart: vi.fn().mockRejectedValue(new Error('db down')) });
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
        tracker,
      });

      const result = await orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: MODEL_ID }) });

      expect(result.billedByTracker).toBe(false);
      expect(tracker.onComplete).not.toHaveBeenCalled();
    });

    it("refuses an in-process delegation the payer's balance cannot start, before any work", async () => {
      const run = vi.spyOn(ReActAgent.prototype, 'run');
      const tracker = makeTracker();
      const checkInsufficientCredits = vi.fn().mockResolvedValue(true);
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(MODEL_ID),
        logger: makeLogger(),
        parentTools: [],
        availableModels: [model],
        tracker,
        checkInsufficientCredits,
      });

      await expect(
        orchestrator.delegateToAgent({ task: 't', agentDef: makeAgentDef({ model: MODEL_ID }) })
      ).rejects.toThrow('Insufficient credits to run subagent');

      expect(checkInsufficientCredits).toHaveBeenCalledWith(MODEL_ID);
      expect(tracker.onStart).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });
  });

  /**
   * Regression coverage for the delegation that 404'd in production: agents
   * default to Bedrock inference-profile ids (`global.anthropic.*`) that a
   * catalog carrying only direct-vendor rows cannot serve. The old code kept
   * the parent's backend but the agent's model, so Anthropic's Messages API
   * received a Bedrock id and returned `not_found_error` before step one.
   */
  describe('model/backend resolution', () => {
    const BEDROCK_ID = 'global.anthropic.claude-sonnet-4-6';
    const DIRECT_ID = 'claude-sonnet-4-6';
    const PARENT_ID = 'claude-opus-5';

    /** Resolver that only knows the ids in `serviceable`, like the real catalog lookup. */
    function makeResolver(serviceable: string[]) {
      return vi.fn((modelId: string) => (serviceable.includes(modelId) ? makeLlm(modelId) : null));
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function stubAgentRun(): void {
      vi.spyOn(ReActAgent.prototype, 'run').mockResolvedValue({
        finalAnswer: 'done',
        steps: [],
        completionInfo: {
          totalTokens: 100,
          totalInputTokens: 80,
          totalOutputTokens: 20,
          totalCredits: 1,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      } satisfies AgentResult);
    }

    it('falls back to the first serviceable model when the agent default is not in the catalog', async () => {
      stubAgentRun();
      const resolveBackend = makeResolver([DIRECT_ID]);
      const logger = makeLogger();

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger,
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: [DIRECT_ID, 'gpt-4.1'] }),
        thoroughness: 'medium',
      });

      // Candidates are tried in order and resolution stops at the first hit.
      expect(resolveBackend).toHaveBeenNthCalledWith(1, BEDROCK_ID);
      expect(resolveBackend).toHaveBeenNthCalledWith(2, DIRECT_ID);
      expect(resolveBackend).toHaveBeenCalledTimes(2);
      expect(result.model).toBe(DIRECT_ID);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(BEDROCK_ID));
    });

    it('runs an agent pinned to a retired model id on its successor', async () => {
      stubAgentRun();
      const RETIRED_ID = 'anthropic.claude-3-haiku-20240307-v1:0';
      const SUCCESSOR_ID = 'global.anthropic.claude-haiku-5-5';
      const resolveBackend = makeResolver([SUCCESSOR_ID]);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: RETIRED_ID }),
        thoroughness: 'medium',
      });

      expect(resolveBackend).toHaveBeenCalledWith(SUCCESSOR_ID);
      expect(resolveBackend).not.toHaveBeenCalledWith(RETIRED_ID);
      expect(result.model).toBe(SUCCESSOR_ID);
    });

    it("reuses the parent's backend when a retired pinned id resolves to the parent's model", async () => {
      stubAgentRun();
      const parentLlm = makeLlm('global.anthropic.claude-haiku-5-5');
      const resolveBackend = makeResolver([]);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: parentLlm,
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: 'anthropic.claude-3-haiku-20240307-v1:0' }),
        thoroughness: 'medium',
      });

      expect(resolveBackend).not.toHaveBeenCalled();
      expect(result.model).toBe('global.anthropic.claude-haiku-5-5');
    });

    it('resolves retired fallback model ids to their successors', async () => {
      stubAgentRun();
      const SUCCESSOR_ID = 'global.anthropic.claude-haiku-5-5';
      const resolveBackend = makeResolver([SUCCESSOR_ID]);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: ['anthropic.claude-3-haiku-20240307-v1:0'] }),
        thoroughness: 'medium',
      });

      expect(resolveBackend).not.toHaveBeenCalledWith('anthropic.claude-3-haiku-20240307-v1:0');
      expect(result.model).toBe(SUCCESSOR_ID);
    });

    it("degrades to the parent's model when no candidate is serviceable", async () => {
      stubAgentRun();
      const resolveBackend = makeResolver([]);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: ['gpt-4.1'] }),
        thoroughness: 'medium',
      });

      // The invariant that broke production: never hand the parent's backend a
      // model id the parent's provider does not serve.
      expect(result.model).toBe(PARENT_ID);
    });

    it('uses the agent default untouched when the catalog serves it', async () => {
      stubAgentRun();
      const resolveBackend = makeResolver([BEDROCK_ID, DIRECT_ID]);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: [DIRECT_ID] }),
        thoroughness: 'medium',
      });

      expect(result.model).toBe(BEDROCK_ID);
      expect(resolveBackend).toHaveBeenCalledTimes(1);
    });

    it('keeps walking the ladder when a candidate throws instead of returning null', async () => {
      stubAgentRun();
      // getLlmByModel throws (rather than returning null) on an unknown adapter
      // family and on an expired provider key. Letting that escape would discard
      // every remaining candidate, including the degrade-to-parent rung.
      const resolveBackend = vi.fn((modelId: string) => {
        if (modelId === BEDROCK_ID) throw new Error('Unsupported adapter family');
        return modelId === DIRECT_ID ? makeLlm(modelId) : null;
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: [DIRECT_ID] }),
        thoroughness: 'medium',
      });

      expect(resolveBackend).toHaveBeenNthCalledWith(2, DIRECT_ID);
      expect(result.model).toBe(DIRECT_ID);
    });

    it("degrades to the parent's model when every candidate throws", async () => {
      stubAgentRun();
      const resolveBackend = vi.fn(() => {
        throw new Error('OpenAI API key is expired');
      });

      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        resolveBackend,
      });

      const result = await orchestrator.delegateToAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: ['gpt-4.1'] }),
        thoroughness: 'medium',
      });

      // The parent is already running on this model, so the delegation survives.
      expect(result.model).toBe(PARENT_ID);
    });

    it('persists a serviceable model on a background child, not the unserviceable default', async () => {
      const tracker = makeTracker();
      const orchestrator = new ServerSubagentOrchestrator({
        userId: 'u1',
        llm: makeLlm(PARENT_ID),
        logger: makeLogger(),
        parentTools: [],
        tracker,
        resolveBackend: makeResolver([DIRECT_ID]),
      });

      await orchestrator.dispatchBackgroundAgent({
        task: 't',
        agentDef: makeAgentDef({ model: BEDROCK_ID, fallbackModels: [DIRECT_ID] }),
        thoroughness: 'medium',
      });

      // The child Lambda rebuilds its backend from this id alone, so an
      // unserviceable one would kill it with "Failed to create LLM backend".
      expect(tracker.onStart).toHaveBeenCalledWith(expect.objectContaining({ model: DIRECT_ID }));
    });
  });
});
