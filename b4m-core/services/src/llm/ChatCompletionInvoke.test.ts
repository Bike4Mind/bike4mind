import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatCompletionInvoke } from './ChatCompletionInvoke';
import { getAvailableModels } from '@bike4mind/llm-adapters';

// getAvailableModels resolves to an empty array in every case below - never reached
// for the rejected-caller test, and used as a downstream sentinel (the "no model
// found" BadRequestError) proving the owner/sharee cases got PAST the access check
// rather than asserting the whole multi-step invoke() pipeline.
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(),
}));
vi.mock('../apiKeyService', () => ({
  getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({ openai: 'key' }),
}));

const mockedGetAvailableModels = vi.mocked(getAvailableModels);

describe('ChatCompletionInvoke.invoke - session access', () => {
  let mockDb: any;
  const OWNER_ID = 'owner-1';
  const SHAREE_ID = 'sharee-1';
  const ATTACKER_ID = 'attacker-1';

  const session = {
    id: 'session-1',
    userId: OWNER_ID,
    users: [{ userId: SHAREE_ID }],
    agentIds: [],
  };

  const body = {
    sessionId: 'session-1',
    historyCount: 1,
    fabFileIds: [],
    message: 'hello',
    messageFileIds: [],
    params: { model: 'gpt-4' },
    queryComplexity: 'simple',
    promptMeta: {},
  };

  beforeEach(() => {
    mockedGetAvailableModels.mockReset().mockResolvedValue([]);
    mockDb = {
      sessions: { findById: vi.fn().mockResolvedValue(session), update: vi.fn() },
      organizations: { findById: vi.fn() },
      quests: { findById: vi.fn(), create: vi.fn(), update: vi.fn() },
      adminSettings: { getSettingsValue: vi.fn() },
    };
  });

  const makeInvoke = () =>
    new ChatCompletionInvoke({
      db: mockDb,
      logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      user: { id: ATTACKER_ID, tags: [] } as any,
      invokeLambda: vi.fn(),
    } as any);

  it('rejects a caller who is neither the owner nor a sharee, before touching models or quests', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: ATTACKER_ID })).rejects.toThrow(/access/i);

    expect(mockedGetAvailableModels).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
    expect(mockDb.sessions.update).not.toHaveBeenCalled();
  });

  it('lets the session owner past the access check', async () => {
    const invoke = makeInvoke();
    // getAvailableModels resolves [] -> "Invalid model" is the downstream sentinel that
    // proves this request cleared the access check (a rejected caller never gets here).
    await expect(invoke.invoke({ body, userId: OWNER_ID })).rejects.toThrow(/Invalid model/);
  });

  it('lets a session sharee (in session.users) past the access check', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: SHAREE_ID })).rejects.toThrow(/Invalid model/);
  });
});
