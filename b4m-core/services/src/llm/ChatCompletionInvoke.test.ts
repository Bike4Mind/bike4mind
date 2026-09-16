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

// promptMeta.model.type is declared as 'text' | 'image' | 'video', while the catalog also serves
// 'speech-to-text'. This guard is what makes the declared union true rather than aspirational: it
// rejects the one modality a completion cannot run, before the field is written and before the
// request reaches a provider that would answer with a raw error.
describe('ChatCompletionInvoke.invoke - model modality', () => {
  let mockDb: any;
  const OWNER_ID = 'owner-1';

  const session = { id: 'session-1', userId: OWNER_ID, users: [], agentIds: [] };

  const bodyFor = (model: string) => ({
    sessionId: 'session-1',
    historyCount: 1,
    fabFileIds: [],
    message: 'hello',
    messageFileIds: [],
    params: { model },
    queryComplexity: 'simple',
    promptMeta: {},
  });

  const modelInfo = (id: string, type: string) => ({
    id,
    type,
    name: id,
    max_tokens: 100,
    contextWindow: 1000,
    pricing: {},
  });

  beforeEach(() => {
    mockedGetAvailableModels.mockReset();
    mockDb = {
      sessions: { findById: vi.fn().mockResolvedValue(session), update: vi.fn() },
      organizations: { findById: vi.fn() },
      // Echo the created document back so questStartParams carries the promptMeta actually written,
      // rather than a fixed stub - the point of the assertions below.
      quests: {
        findById: vi.fn(),
        create: vi.fn(async (quest: any) => ({ id: 'quest-1', ...quest })),
        update: vi.fn(),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002') },
    };
  });

  const makeInvoke = () =>
    new ChatCompletionInvoke({
      db: mockDb,
      logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      user: { id: OWNER_ID, tags: [] } as any,
      invokeLambda: vi.fn(),
    } as any);

  it('rejects a speech-to-text model before writing promptMeta or touching the session', async () => {
    mockedGetAvailableModels.mockResolvedValue([modelInfo('whisper-1', 'speech-to-text')] as any);

    const invoke = makeInvoke();
    await expect(invoke.invoke({ body: bodyFor('whisper-1'), userId: OWNER_ID })).rejects.toThrow(
      /cannot run a chat completion/
    );

    expect(mockDb.sessions.update).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
  });

  // Media models run through this same path, so the guard must not turn into a text-only gate.
  // questStartParams is asserted rather than the create() argument because it runs the stored
  // promptMeta back through PromptMetaZodSchema - the same enum this write must satisfy.
  it.each(['text', 'image', 'video'])('records %s unchanged on promptMeta.model.type', async type => {
    mockedGetAvailableModels.mockResolvedValue([modelInfo('some-model', type)] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor('some-model'), userId: OWNER_ID });

    expect(mockDb.quests.create).toHaveBeenCalledWith(
      expect.objectContaining({ promptMeta: expect.objectContaining({ model: expect.objectContaining({ type }) }) })
    );
    expect((invoke as any).questStartParams?.promptMeta?.model?.type).toBe(type);
  });

  // ModelInfo.type is declared required, so a row without one is a data defect - but it is the
  // catalog's defect, not the caller's, and refusing the turn over it would eat a working
  // completion. It degrades to unrecorded, which resolveQuestModelType already handles.
  it('runs a model whose catalog row carries no type, recording no modality', async () => {
    const { type: _omitted, ...typeless } = modelInfo('mystery-model', 'text');
    mockedGetAvailableModels.mockResolvedValue([typeless] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor('mystery-model'), userId: OWNER_ID });

    expect(mockDb.quests.create).toHaveBeenCalled();
    expect((invoke as any).questStartParams?.promptMeta?.model?.type).toBeUndefined();
  });
});
