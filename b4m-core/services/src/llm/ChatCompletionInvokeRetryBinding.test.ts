import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the two collaborators that reach out of process need mocking; the error classes and
// helpers from @bike4mind/utils stay real so the code under test behaves normally.
vi.mock('../apiKeyService', () => ({
  getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', disabled: false }]),
}));

import { ChatCompletionInvoke } from './ChatCompletionInvoke';

const SESSION = 'session-owned';

const makeHarness = (questDoc: Record<string, unknown> | null) => {
  const questsUpdate = vi.fn().mockResolvedValue(undefined);
  const invokeLambda = vi.fn().mockResolvedValue(undefined);

  const db = {
    sessions: {
      findById: vi.fn().mockResolvedValue({ id: SESSION, agentIds: [] }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    quests: {
      findById: vi.fn().mockResolvedValue(questDoc),
      update: questsUpdate,
      create: vi.fn(),
    },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    adminSettings: {
      getSettingsValue: vi.fn().mockResolvedValue('text-embedding-3-small'),
      findOne: vi.fn().mockResolvedValue({ settingValue: [] }),
    },
  };

  const options = {
    db,
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    user: { id: 'user-A', isAdmin: false, tags: [] },
    invokeLambda,
  };

  const invoke = new ChatCompletionInvoke(options as unknown as ConstructorParameters<typeof ChatCompletionInvoke>[0]);
  return { invoke, questsUpdate, invokeLambda };
};

const body = {
  sessionId: SESSION,
  historyCount: 0,
  fabFileIds: [],
  message: 'retry this',
  questId: 'quest-1',
  params: { model: 'test-model' },
};

describe('ChatCompletionInvoke retry path session binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to overwrite a quest that belongs to a different session', async () => {
    const { invoke, questsUpdate } = makeHarness({ id: 'quest-1', sessionId: 'someone-elses-session' });

    const result = await invoke.invoke({ body: body as never, userId: 'user-A' });

    // Guard returns null -> invoke bails before the retry overwrite; the foreign quest is untouched.
    expect(result).toBeUndefined();
    expect(questsUpdate).not.toHaveBeenCalled();
  });

  it('proceeds with a legitimate same-session retry', async () => {
    const { invoke, questsUpdate } = makeHarness({ id: 'quest-1', sessionId: SESSION });

    const result = await invoke.invoke({ body: body as never, userId: 'user-A' });

    expect(result).toBeDefined();
    // guard let it through: the retry overwrite ran (status flipped to running)
    expect(questsUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
  });
});
