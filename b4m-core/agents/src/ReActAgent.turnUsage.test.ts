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
});
