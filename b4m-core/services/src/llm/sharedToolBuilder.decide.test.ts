/**
 * The `decide` host hook has to survive the whole builder hop: host -> ToolBuilderDeps ->
 * buildSharedTools -> generateTools -> ToolContext. This asserts the built tool actually reaches
 * the hook, since a dropped forward is invisible until a user calls the tool.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from './sharedToolBuilder';
import { ServerAgentStore } from './agents/ServerAgentStore';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getLlmByModel: vi.fn(() => ({ complete: vi.fn(), currentModel: '' })),
}));

const answer = {
  id: 'dec_1',
  object: 'decision' as const,
  model: 'test-decisions',
  answers: [
    { type: 'predicate' as const, name: 'is_urgent', probability: 0.9 },
    { type: 'refusal' as const, name: 'team' },
  ],
  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
};

const decide = vi.fn(async () => answer);

const fakeStorage = {
  upload: vi.fn(),
  getSignedUrl: vi.fn(),
  getPublicUrl: vi.fn(),
} as unknown as ToolBuilderDeps['storage'];

const deps: ToolBuilderDeps = {
  userId: 'test-user',
  user: { _id: 'test-user', id: 'test-user' } as unknown as IUserDocument,
  logger: new Logger(),
  db: {} as ToolBuilderDeps['db'],
  storage: fakeStorage,
  imageGenerateStorage: fakeStorage,
  llm: { complete: vi.fn(), currentModel: 'test-model' } as unknown as ICompletionBackend,
  model: 'test-model',
  agentStore: new ServerAgentStore({}),
  authOrigin: 'session',
  decide,
};

const callbacks: ToolBuilderCallbacks = {
  onStatusUpdate: async () => {},
  onToolStart: async () => {},
  onToolFinish: async () => {},
};

describe('buildSharedTools: decide host hook', () => {
  it('reaches the built tool with the turn context and returns the answers in question order', async () => {
    const tools = buildSharedTools(deps, callbacks, { enabledTools: ['decide'] });
    const tool = tools?.find(entry => entry.toolSchema.name === 'decide');
    expect(tool).toBeDefined();

    const result = await tool!.toolFn({
      input: 'Help! Payouts have been failing.',
      questions: [
        { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24h.' },
        { type: 'choice', name: 'team', instructions: 'Which team?', choices: [{ value: 'billing' }] },
      ],
    });

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user',
        authOrigin: 'session',
        request: expect.objectContaining({ input: 'Help! Payouts have been failing.' }),
      })
    );
    const payload = JSON.parse(result as string);
    expect(payload).toEqual({ id: 'dec_1', model: 'test-decisions', answers: answer.answers });
    expect(payload.answers.map((entry: { name: string }) => entry.name)).toEqual(['is_urgent', 'team']);
  });
});
