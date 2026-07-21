/**
 * Regression: token counters must honor the assign-not-add contract (#657).
 *
 * Streaming backends invoke the completion callback once per chunk, each time
 * carrying the CUMULATIVE running token total (see `buildCompletionInfo` in
 * bedrockBackend/base.ts and the contract note in cliCompletions.ts). ReActAgent
 * previously used `+=` inside that callback, which re-added the whole prompt-token
 * count on every streamed chunk and multiplied a single iteration's input tokens
 * by the chunk count. A live agent-mode `deep_research` run reported ~49M input
 * tokens for a ~72K-token prompt, over-charging COGS/credits.
 *
 * These tests pin the fixed behavior: within one `complete()` call the final
 * cumulative wins (never the sum across frames), and across iterations the totals
 * are the sum of each call's final cumulative.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent, foldCompletionInfo, type CompletionFoldBaselines } from './ReActAgent';
import type { AgentContext } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { CacheUsageStats, IMessage } from '@bike4mind/common';

/** Full CacheUsageStats with the two token fields the fold reads; rest are filler. */
function cacheStats(cacheReadTokens: number, cacheWriteTokens: number): CacheUsageStats {
  return {
    provider: 'anthropic',
    model: 'test-model',
    totalInputTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
    uncachedTokens: 0,
    cacheHitRate: 0,
    costSavingsPercent: 0,
    estimatedLatencyReduction: 0,
  };
}

function createMockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * A streaming backend that emits `frames` text chunks for each `complete()` call,
 * every callback carrying the SAME cumulative inputTokens and a monotonically
 * growing cumulative outputTokens - the real per-chunk emission pattern. Per call,
 * the correct totals are the LAST cumulative values, i.e. `cumulativeInputTokens`
 * and `frames * 10`.
 */
function createCumulativeUsageLlm(cumulativeInputTokens: number, frames: number): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      for (let i = 1; i <= frames; i++) {
        await callback([`chunk${i}`], {
          inputTokens: cumulativeInputTokens, // cumulative: prompt is fixed, constant across frames
          outputTokens: i * 10, // cumulative: grows as more output streams
          toolsUsed: [],
        });
      }
    },
    pushToolMessages: vi.fn(),
  };
}

function createContext(llm: ICompletionBackend, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: createMockLogger() as any,
    llm,
    model: 'test-model',
    tools: [],
    maxIterations: 5,
    ...overrides,
  };
}

describe('ReActAgent token accounting (#657)', () => {
  it('run(): a single iteration counts the final cumulative, not the per-chunk sum', async () => {
    const FRAMES = 5;
    const llm = createCumulativeUsageLlm(1000, FRAMES);

    const agent = new ReActAgent(createContext(llm));
    const result = await agent.run('q');

    // Correct: the final cumulative (1000), NOT 1000 * FRAMES (the old `+=` bug).
    expect(result.completionInfo.totalInputTokens).toBe(1000);
    // Output is cumulative too: last frame's value (FRAMES * 10), not the sum of frames.
    expect(result.completionInfo.totalOutputTokens).toBe(FRAMES * 10);
    expect(result.completionInfo.totalTokens).toBe(1000 + FRAMES * 10);
  });

  it('runIteration(): the agent-mode path counts the final cumulative, not the per-chunk sum', async () => {
    const FRAMES = 8;
    const llm = createCumulativeUsageLlm(72_000, FRAMES);

    const agent = new ReActAgent(createContext(llm));
    await agent.runIteration('q', { maxHistoryIterations: 0 });

    const checkpoint = agent.toCheckpoint();
    // The bug turned a 72K-token prompt into 72K * FRAMES; assert the real value.
    expect(checkpoint.totalInputTokens).toBe(72_000);
    expect(checkpoint.totalOutputTokens).toBe(FRAMES * 10);
  });

  it('runIteration(): input tokens accumulate as the sum of each iteration final across iterations', async () => {
    // Iteration 1 calls a tool (cumulative input 1000 over 4 frames), iteration 2
    // produces the final answer (cumulative input 2500 over 3 frames).
    let call = 0;
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        _messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
      ) => {
        call++;
        if (call === 1) {
          for (let i = 1; i <= 3; i++) {
            await callback([`t${i}`], { inputTokens: 1000, outputTokens: i * 10, toolsUsed: [] });
          }
          await callback([null], {
            inputTokens: 1000,
            outputTokens: 30,
            toolsUsed: [{ name: 'ping', arguments: '{}', id: 'tool1' }],
          });
        } else {
          for (let i = 1; i <= 2; i++) {
            await callback([`a${i}`], { inputTokens: 2500, outputTokens: i * 10, toolsUsed: [] });
          }
          await callback([null], { inputTokens: 2500, outputTokens: 20, toolsUsed: [] });
        }
      },
      pushToolMessages: vi.fn(),
    };

    const agent = new ReActAgent(
      createContext(llm, {
        tools: [
          {
            toolFn: async () => 'pong',
            toolSchema: {
              name: 'ping',
              description: 'ping',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ],
      })
    );

    await agent.runIteration('q', { maxHistoryIterations: 0 });
    await agent.runIteration('q', { maxHistoryIterations: 0 });

    const checkpoint = agent.toCheckpoint();
    // Sum of each call's FINAL cumulative: 1000 + 2500. The old `+=` bug would
    // report (1000 * 4) + (2500 * 3) = 11,500.
    expect(checkpoint.totalInputTokens).toBe(3500);
  });

  it('runIteration(): a trailing token-less frame does NOT zero the running total (presence guard)', async () => {
    // Real backends emit the cumulative tokens on the content frames, then a
    // final frame carrying only the stop reason and no token counts. Without the
    // presence guard the trailing frame folds `baseline + 0` and resets the
    // iteration's input tokens to the baseline (0 here). Pin the guard.
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (_model, _messages, _options, callback) => {
        await callback(['a'], { inputTokens: 5000, outputTokens: 10, toolsUsed: [] });
        await callback(['b'], { inputTokens: 5000, outputTokens: 20, toolsUsed: [] });
        // Trailing frame: stop reason only, no token counts.
        await callback([null], { toolsUsed: [], stopReason: 'end_turn' });
      },
      pushToolMessages: vi.fn(),
    };

    const agent = new ReActAgent(createContext(llm));
    await agent.runIteration('q', { maxHistoryIterations: 0 });

    const checkpoint = agent.toCheckpoint();
    // Stays at the last non-zero cumulative (5000), NOT reset to 0 by the
    // token-less trailing frame.
    expect(checkpoint.totalInputTokens).toBe(5000);
    expect(checkpoint.totalOutputTokens).toBe(20);
  });

  it('runIteration(): cache tokens fold to the final cumulative, not the per-frame sum', async () => {
    // The mock backend now emits cumulative cacheStats so the #657 bug class
    // (cache-write tokens billed ~1.25x when summed) has a regression guard.
    const llm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (_model, _messages, _options, callback) => {
        // cacheRead is constant (prompt cache is fixed); cacheWrite grows then settles.
        await callback(['a'], { inputTokens: 100, outputTokens: 10, cacheStats: cacheStats(800, 200), toolsUsed: [] });
        await callback(['b'], { inputTokens: 100, outputTokens: 20, cacheStats: cacheStats(800, 200), toolsUsed: [] });
        await callback(['c'], { inputTokens: 100, outputTokens: 30, cacheStats: cacheStats(800, 200), toolsUsed: [] });
      },
      pushToolMessages: vi.fn(),
    };

    const agent = new ReActAgent(createContext(llm));
    await agent.runIteration('q', { maxHistoryIterations: 0 });

    const checkpoint = agent.toCheckpoint();
    // Final cumulative, NOT 800*3 / 200*3 that a `+=` fold would produce.
    expect(checkpoint.totalCacheReadTokens).toBe(800);
    expect(checkpoint.totalCacheWriteTokens).toBe(200);
  });
});

describe('foldCompletionInfo (#657 assign-not-add contract)', () => {
  const baselines: CompletionFoldBaselines = {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    credits: 5,
  };

  it('folds baseline + cumulative and is idempotent across identical frames', () => {
    const first = foldCompletionInfo({ inputTokens: 500, outputTokens: 40 }, baselines, { ...baselines });
    expect(first.inputTokens).toBe(1500);
    expect(first.outputTokens).toBe(140);
    expect(first.totalTokens).toBe(1640);

    // A second frame carrying the SAME cumulative must not double-count.
    const second = foldCompletionInfo({ inputTokens: 500, outputTokens: 40 }, baselines, first);
    expect(second.inputTokens).toBe(1500);
    expect(second.outputTokens).toBe(140);
  });

  it('keeps the current value when a field is absent (trailing token-less frame)', () => {
    const current: CompletionFoldBaselines = { ...baselines, inputTokens: 1500, outputTokens: 140 };
    const folded = foldCompletionInfo({ stopReason: 'end_turn' } as CompletionInfo, baselines, current);
    // Neither reset to baseline (1000) nor zeroed - the running total survives.
    expect(folded.inputTokens).toBe(1500);
    expect(folded.outputTokens).toBe(140);
  });

  it('value-guards cache tokens: a zero sub-field keeps the current total (not baseline)', () => {
    const current: CompletionFoldBaselines = { ...baselines, cacheReadTokens: 900, cacheWriteTokens: 250 };
    const folded = foldCompletionInfo({ cacheStats: cacheStats(0, 0) }, baselines, current);
    expect(folded.cacheReadTokens).toBe(900);
    expect(folded.cacheWriteTokens).toBe(250);
  });

  it('folds present cache tokens as baseline + cumulative', () => {
    const folded = foldCompletionInfo({ cacheStats: cacheStats(800, 200) }, baselines, { ...baselines });
    expect(folded.cacheReadTokens).toBe(900); // 100 + 800
    expect(folded.cacheWriteTokens).toBe(250); // 50 + 200
  });
});
