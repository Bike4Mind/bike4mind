import { describe, it, expect, vi } from 'vitest';
import { ReActAgent } from './ReActAgent';
import type { ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function optionsSentFor(identity: { modelIdentityId?: string; modelDisplayName?: string }) {
  const seen: Array<Partial<ICompletionOptions>> = [];
  const llm: ICompletionBackend = {
    currentModel: 'run-model',
    getModelInfo: async () => [],
    complete: async (_model, _messages, options, callback) => {
      seen.push(options);
      await callback(['done'], { inputTokens: 1, outputTokens: 1, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
  const agent = new ReActAgent({
    userId: 'u1',
    logger: logger as unknown as Logger,
    llm,
    model: 'run-model',
    tools: [],
    ...identity,
  });
  await agent.run('hi');
  return seen[0];
}

describe('ReActAgent identity options', () => {
  it('passes the identity model to the backend when set', async () => {
    expect(await optionsSentFor({ modelIdentityId: 'asked-model', modelDisplayName: 'Asked' })).toMatchObject({
      modelIdentityId: 'asked-model',
      modelDisplayName: 'Asked',
    });
  });

  it('sends none when unset', async () => {
    expect(await optionsSentFor({})).not.toHaveProperty('modelIdentityId');
  });
});
