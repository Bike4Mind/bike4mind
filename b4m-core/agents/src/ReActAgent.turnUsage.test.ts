/**
 * ReActAgent exposes one usage entry per provider request (CompletionInfo.turnUsage), so cost
 * callers can price each request on its own long-context tier instead of the run's totals.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { AgentContext, AgentCheckpoint } from './types';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';

type Frame = CompletionInfo & { text: string };

// Only the field the agent folds; the rest of CacheUsageStats is irrelevant here.
const cacheRead = (cacheReadTokens: number) => ({ cacheReadTokens }) as CompletionInfo['cacheStats'];

/** Each `complete()` call emits the next scripted frame (or throws when the entry is an Error). */
function scriptedLlm(script: Array<Frame | Error>): ICompletionBackend {
  let call = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
    ) => {
      const step = script[Math.min(call++, script.length - 1)];
      if (step instanceof Error) throw step;
      const { text, ...info } = step;
      await callback([text], info);
    },
    pushToolMessages: vi.fn(),
  };
}

/** Each `complete()` call streams its scripted frames in order. */
function framedLlm(calls: Frame[][]): ICompletionBackend {
  let call = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_model, _messages, _options, callback) => {
      for (const { text, ...info } of calls[Math.min(call++, calls.length - 1)]) {
        await callback([text], info);
      }
    },
    pushToolMessages: vi.fn(),
  };
}

const searchTool = {
  toolFn: vi.fn(async () => 'result'),
  toolSchema: {
    name: 'search',
    description: 'search',
    parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
  },
};

function context(llm: ICompletionBackend): AgentContext {
  return {
    userId: 'u1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    llm,
    model: 'test-model',
    tools: [searchTool],
    maxIterations: 5,
  };
}

const toolIteration: Frame = {
  text: 'Searching.',
  inputTokens: 1000,
  outputTokens: 20,
  cacheStats: cacheRead(150_000),
  toolsUsed: [{ name: 'search', arguments: '{}' }],
  turnUsage: [{ inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 }],
};
// An adapter that reports no per-request breakdown: the iteration's totals stand in as one turn.
const finalIteration: Frame = {
  text: 'Done.',
  inputTokens: 2000,
  outputTokens: 30,
  cacheStats: cacheRead(151_000),
  toolsUsed: [],
  stopReason: 'end_turn',
};

describe('ReActAgent per-request usage', () => {
  it('run(): reports one entry per iteration, from the adapter or the iteration totals', async () => {
    const agent = new ReActAgent(context(scriptedLlm([toolIteration, finalIteration])));

    const result = await agent.run('find it');

    expect(result.completionInfo.turnUsage).toEqual([
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ]);
    expect(result.completionInfo.totalInputTokens).toBe(3000);
    expect(result.completionInfo.totalCacheReadTokens).toBe(301_000);
  });

  it('run(): drops a failed attempt rolled back by reactive compaction', async () => {
    const failed: Frame = { text: 'partial', inputTokens: 999, outputTokens: 999, toolsUsed: [] };
    let attempts = 0;
    const llm = scriptedLlm([finalIteration]);
    const complete = llm.complete.bind(llm);
    llm.complete = async (model, messages, options, callback) => {
      if (attempts++ === 0) {
        await callback(['partial'], failed);
        throw new Error('prompt is too long');
      }
      return complete(model, messages, options, callback);
    };
    const agent = new ReActAgent(context(llm));

    const result = await agent.run('find it', { onContextLimit: async messages => [messages[0]] });

    expect(result.completionInfo.turnUsage).toEqual([
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ]);
  });

  it('runIteration(): carries the turns through a checkpoint and resume', async () => {
    const first = new ReActAgent(context(scriptedLlm([toolIteration])));
    const { checkpoint } = await first.runIteration('find it');
    expect(checkpoint.turnUsage).toEqual(toolIteration.turnUsage);

    const resumed = new ReActAgent(context(scriptedLlm([finalIteration])));
    resumed.fromCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
    const { checkpoint: next } = await resumed.runIteration();

    expect(next.turnUsage).toEqual([
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ]);
  });

  it('fromCheckpoint(): a checkpoint saved before turns were tracked keeps its totals as one turn', async () => {
    const first = new ReActAgent(context(scriptedLlm([toolIteration])));
    const { checkpoint } = await first.runIteration('find it');
    const legacy: AgentCheckpoint = { ...checkpoint, turnUsage: undefined };

    const resumed = new ReActAgent(context(scriptedLlm([finalIteration])));
    resumed.fromCheckpoint(legacy);

    expect(resumed.toCheckpoint().turnUsage).toEqual([
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
    ]);
  });

  it('runIteration(): a later frame of the same request replaces its turn instead of adding one', async () => {
    const early: Frame = { ...toolIteration, outputTokens: 5, turnUsage: [{ inputTokens: 1000, outputTokens: 5 }] };
    const agent = new ReActAgent(context(framedLlm([[early, toolIteration]])));

    const { checkpoint } = await agent.runIteration('find it');

    expect(checkpoint.turnUsage).toEqual(toolIteration.turnUsage);
  });

  it('runIteration(): a trailing frame without turnUsage keeps the breakdown an earlier frame reported', async () => {
    // Two reported entries so a fallback to the iteration totals (one entry) is distinguishable.
    const reported = [
      { inputTokens: 400, outputTokens: 10 },
      { inputTokens: 600, outputTokens: 10, cacheReadInputTokens: 150_000 },
    ];
    const trailing: Frame = { text: '', stopReason: 'tool_use' };
    const agent = new ReActAgent(context(framedLlm([[{ ...toolIteration, turnUsage: reported }, trailing]])));

    const { checkpoint } = await agent.runIteration('find it');

    expect(checkpoint.turnUsage).toEqual(reported);
  });

  it('runIteration(): an OpenAI-shaped frame (top-level cache fields, no cacheStats) keeps turns and totals in step', async () => {
    const openAiFrame: Frame = {
      text: 'Searching.',
      inputTokens: 1000,
      outputTokens: 20,
      cacheReadInputTokens: 150_000,
      cacheCreationInputTokens: 2_000,
      toolsUsed: [{ name: 'search', arguments: '{}' }],
      turnUsage: [
        { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000, cacheCreationInputTokens: 2_000 },
      ],
    };
    const agent = new ReActAgent(context(scriptedLlm([openAiFrame])));

    const { checkpoint } = await agent.runIteration('find it');

    expect(checkpoint.totalCacheReadTokens).toBe(150_000);
    expect(checkpoint.totalCacheWriteTokens).toBe(2_000);
    expect(checkpoint.turnUsage).toEqual(openAiFrame.turnUsage);
  });

  it('run(): synthesizes cache writes into the turn, and records no turn for an iteration with no usage', async () => {
    const withWrite: Frame = {
      ...toolIteration,
      cacheStats: { cacheReadTokens: 0, cacheWriteTokens: 3_000 } as CompletionInfo['cacheStats'],
      turnUsage: undefined,
    };
    const noUsage: Frame = { text: 'Done.', toolsUsed: [], stopReason: 'end_turn' };
    const agent = new ReActAgent(context(scriptedLlm([withWrite, noUsage])));

    const result = await agent.run('find it');

    expect(result.completionInfo.turnUsage).toEqual([
      { inputTokens: 1000, outputTokens: 20, cacheCreationInputTokens: 3_000 },
    ]);
  });

  it('a reused agent starts each run with no turns from the previous one', async () => {
    const agent = new ReActAgent(context(scriptedLlm([finalIteration])));
    await agent.run('first');

    const second = await agent.run('second');
    expect(second.completionInfo.turnUsage).toHaveLength(1);

    const { checkpoint } = await agent.runIteration('third');
    expect(checkpoint.turnUsage).toHaveLength(1);
  });

  it('run(): a trailing frame without turnUsage keeps the breakdown an earlier frame reported', async () => {
    const reported = [
      { inputTokens: 400, outputTokens: 10 },
      { inputTokens: 600, outputTokens: 20, cacheReadInputTokens: 151_000 },
    ];
    const trailing: Frame = { text: '', stopReason: 'end_turn' };
    const agent = new ReActAgent(context(framedLlm([[{ ...finalIteration, turnUsage: reported }, trailing]])));

    const result = await agent.run('find it');

    expect(result.completionInfo.turnUsage).toEqual(reported);
  });

  it('run(): an aborted run still reports the turns it spent', async () => {
    const controller = new AbortController();
    const abortingTool = {
      ...searchTool,
      toolFn: vi.fn(async () => {
        controller.abort();
        return 'result';
      }),
    };
    const agent = new ReActAgent({ ...context(scriptedLlm([toolIteration])), tools: [abortingTool] });

    const result = await agent.run('find it', { signal: controller.signal });

    expect(result.finalAnswer).toBe('Interrupted');
    expect(result.completionInfo.turnUsage).toEqual(toolIteration.turnUsage);
  });
});
