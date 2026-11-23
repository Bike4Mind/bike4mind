import { describe, expect, it, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { ICompletionBackend, CompletionInfo, ICompletionOptionTools } from '@bike4mind/llm-adapters';

const makeTool = (name: string, toolFn: () => Promise<string>): ICompletionOptionTools => ({
  toolFn: vi.fn(toolFn),
  toolSchema: { name, description: `tool ${name}`, parameters: { type: 'object', properties: {}, required: [] } },
});

/** Calls `calls` (tool names) in its first turn, then answers. */
const makeLlm = (calls: string[]): ICompletionBackend => {
  let turn = 0;
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (_model, _messages, _options, callback: (t: string[], info?: CompletionInfo) => Promise<void>) => {
      turn++;
      await callback(turn === 1 ? ['thinking'] : ['done'], {
        inputTokens: 10,
        outputTokens: 5,
        toolsUsed: turn === 1 ? calls.map((name, i) => ({ id: `call-${i}`, name, arguments: '{}' })) : [],
      });
    },
    pushToolMessages: vi.fn(),
  };
};

const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as never;

const makeAgent = (calls: string[], tools: ICompletionOptionTools[]) =>
  new ReActAgent({ userId: 'u', logger: makeLogger(), llm: makeLlm(calls), model: 'test-model', tools });

describe('ReActAgent.takeToolFailures', () => {
  it('names an unavailable tool and a throwing tool once each, then clears them', async () => {
    const throws = makeTool('flaky', async () => {
      throw new Error('boom');
    });
    const fine = makeTool('fine', async () => 'ok');
    const agent = makeAgent(['missing', 'missing', 'flaky', 'flaky', 'fine'], [throws, fine]);

    await agent.run('test');

    expect(agent.takeToolFailures()).toEqual({ unavailable: ['missing'], errored: ['flaky'] });
    expect(agent.takeToolFailures()).toEqual({ unavailable: [], errored: [] });
  });

  it('keeps at most 20 names of each', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `gone_${i}`);
    const agent = makeAgent(names, []);

    await agent.run('test');

    const { unavailable } = agent.takeToolFailures();
    expect(unavailable).toHaveLength(20);
    expect(unavailable[0]).toBe('gone_0');
  });

  it('clips a long tool name to 200 chars', async () => {
    const agent = makeAgent(['x'.repeat(300)], []);

    await agent.run('test');

    expect(agent.takeToolFailures().unavailable).toEqual(['x'.repeat(200)]);
  });
});
