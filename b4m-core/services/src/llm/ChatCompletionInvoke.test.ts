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
  const EDITOR_ID = 'editor-1';
  const ATTACKER_ID = 'attacker-1';

  const session = {
    id: 'session-1',
    userId: OWNER_ID,
    users: [
      { userId: SHAREE_ID, permissions: ['read'] },
      { userId: EDITOR_ID, permissions: ['read', 'update'] },
    ],
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

  it('rejects a read-only sharee, who must not drive a completion that writes to the notebook', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: SHAREE_ID })).rejects.toThrow(/access/i);

    expect(mockedGetAvailableModels).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
    expect(mockDb.sessions.update).not.toHaveBeenCalled();
  });

  it('lets a sharee holding update past the access check', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: EDITOR_ID })).rejects.toThrow(/Invalid model/);
  });

  // questStartParams - NOT the parsed request - is what dispatchQuest ships to the async worker, so
  // a request field missing from that literal is silently dropped on every path except `wait: true`.
  // promptMode is asserted alongside because the two must travel together: it is the sibling that
  // already worked, so a failure here names the asymmetry rather than just "field missing".
  it('carries skipAutoOffers and promptMode onto questStartParams, across the async boundary', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: 'gpt-4', type: 'text', name: 'GPT-4', max_tokens: 100, contextWindow: 1000, pricing: {} },
    ] as any);
    mockDb.quests.create.mockResolvedValue({ id: 'quest-1', promptMeta: {} });
    // Unset, invoke() short-circuits into an error quest before questStartParams is ever built.
    mockDb.adminSettings.getSettingsValue.mockResolvedValue('text-embedding-ada-002');

    const invoke = makeInvoke();
    await invoke.invoke({
      body: { ...body, skipAutoOffers: true, promptMode: 'raw' as const },
      userId: OWNER_ID,
    });

    expect((invoke as any).questStartParams).toEqual(
      expect.objectContaining({ skipAutoOffers: true, promptMode: 'raw' })
    );
  });
});
