import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

// Mirrors ChatCompletionInvokeRetryBinding.test.ts: only the two out-of-process collaborators are
// mocked, so the error classes and guards under test stay real.
vi.mock('../apiKeyService', () => ({
  getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', disabled: false }]),
}));

import { ChatCompletionInvoke } from './ChatCompletionInvoke';

const SESSION = 'session-owned';

const makeHarness = (correctedDoc: Record<string, unknown> | null) => {
  const questsCreate = vi
    .fn()
    .mockImplementation(async (doc: Record<string, unknown>) => ({ id: 'new-quest', ...doc }));
  const questsUpdate = vi.fn().mockResolvedValue(undefined);

  const db = {
    sessions: {
      findById: vi.fn().mockResolvedValue({ id: SESSION, userId: 'user-A', agentIds: [] }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    quests: {
      findById: vi.fn().mockResolvedValue(correctedDoc),
      update: questsUpdate,
      create: questsCreate,
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
    invokeLambda: vi.fn().mockResolvedValue(undefined),
  };

  const invoke = new ChatCompletionInvoke(options as unknown as ConstructorParameters<typeof ChatCompletionInvoke>[0]);
  return { invoke, questsCreate, questsUpdate };
};

const body = {
  sessionId: SESSION,
  historyCount: 0,
  fabFileIds: [],
  message: 'the revenue figure is for Q3, not Q2',
  correctsQuestId: 'quest-1',
  params: { model: 'test-model' },
};

describe('ChatCompletionInvoke correct-and-retry binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links a legitimate same-session correction to the turn it corrects', async () => {
    const { invoke, questsCreate, questsUpdate } = makeHarness({ id: 'quest-1', sessionId: SESSION });

    await invoke.invoke({ body: body as never, userId: 'user-A' });

    expect(questsCreate).toHaveBeenCalledWith(expect.objectContaining({ correctsQuestId: 'quest-1' }));
    // The whole point of the feature: the corrected answer has to survive to be half of an
    // evaluation pair, so the flagged quest must never be overwritten the way `questId` does.
    expect(questsUpdate).not.toHaveBeenCalled();
  });

  it('refuses to chain onto a quest belonging to a different session', async () => {
    const { invoke, questsCreate } = makeHarness({ id: 'quest-1', sessionId: 'someone-elses-session' });

    await expect(invoke.invoke({ body: body as never, userId: 'user-A' })).rejects.toBeInstanceOf(NotFoundError);
    expect(questsCreate).not.toHaveBeenCalled();
  });

  it('refuses a correction of a quest that no longer exists', async () => {
    const { invoke, questsCreate } = makeHarness(null);

    await expect(invoke.invoke({ body: body as never, userId: 'user-A' })).rejects.toBeInstanceOf(NotFoundError);
    expect(questsCreate).not.toHaveBeenCalled();
  });

  // Combining the two would take the retry branch, which overwrites the flagged quest in place and
  // drops correctsQuestId entirely - the silent version of losing the feature.
  it('refuses to combine a correction with an in-place retry', async () => {
    const { invoke, questsCreate, questsUpdate } = makeHarness({ id: 'quest-1', sessionId: SESSION });

    await expect(
      invoke.invoke({ body: { ...body, questId: 'quest-1' } as never, userId: 'user-A' })
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(questsCreate).not.toHaveBeenCalled();
    expect(questsUpdate).not.toHaveBeenCalled();
  });

  it('leaves an ordinary turn unlinked', async () => {
    const { invoke, questsCreate } = makeHarness(null);

    await invoke.invoke({ body: { ...body, correctsQuestId: undefined } as never, userId: 'user-A' });

    expect(questsCreate).toHaveBeenCalledWith(expect.objectContaining({ correctsQuestId: undefined }));
  });
});
