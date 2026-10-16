import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatCompletionInvoke } from './ChatCompletionInvoke';
import { getAvailableModels, resetReplacedByOverlay, updateReplacedByOverlay } from '@bike4mind/llm-adapters';

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
    await expect(invoke.invoke({ body, userId: ATTACKER_ID, authOrigin: 'session' })).rejects.toThrow(/access/i);

    expect(mockedGetAvailableModels).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
    expect(mockDb.sessions.update).not.toHaveBeenCalled();
  });

  it('lets the session owner past the access check', async () => {
    const invoke = makeInvoke();
    // getAvailableModels resolves [] -> "Invalid model" is the downstream sentinel that
    // proves this request cleared the access check (a rejected caller never gets here).
    await expect(invoke.invoke({ body, userId: OWNER_ID, authOrigin: 'session' })).rejects.toThrow(/Invalid model/);
  });

  it('rejects a read-only sharee, who must not drive a completion that writes to the notebook', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: SHAREE_ID, authOrigin: 'session' })).rejects.toThrow(/access/i);

    expect(mockedGetAvailableModels).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
    expect(mockDb.sessions.update).not.toHaveBeenCalled();
  });

  it('lets a sharee holding update past the access check', async () => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: EDITOR_ID, authOrigin: 'session' })).rejects.toThrow(/Invalid model/);
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
      authOrigin: 'session',
    });

    expect((invoke as any).questStartParams).toEqual(
      expect.objectContaining({ skipAutoOffers: true, promptMode: 'raw' })
    );
  });
  // Same boundary: a workflow-style caller's integration isolation would silently lapse on the
  // async path, handing a prompt the user did not write their MCP servers, agents and skills.
  it('carries disableUserIntegrations onto questStartParams', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: 'gpt-4', type: 'text', name: 'GPT-4', max_tokens: 100, contextWindow: 1000, pricing: {} },
    ] as any);
    mockDb.quests.create.mockResolvedValue({ id: 'quest-1', promptMeta: {} });
    mockDb.adminSettings.getSettingsValue.mockResolvedValue('text-embedding-ada-002');

    const invoke = makeInvoke();
    await invoke.invoke({
      body: { ...body, disableUserIntegrations: true },
      userId: OWNER_ID,
      authOrigin: 'session',
    });

    expect((invoke as any).questStartParams).toEqual(expect.objectContaining({ disableUserIntegrations: true }));
  });
  // Same boundary: a route's server-set deniedTools (e.g. an API key's missing datalake:write)
  // would silently stop being enforced on the async path if the literal dropped it.
  it('carries deniedTools onto questStartParams', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: 'gpt-4', type: 'text', name: 'GPT-4', max_tokens: 100, contextWindow: 1000, pricing: {} },
    ] as any);
    mockDb.quests.create.mockResolvedValue({ id: 'quest-1', promptMeta: {} });
    mockDb.adminSettings.getSettingsValue.mockResolvedValue('text-embedding-ada-002');

    const invoke = makeInvoke();
    await invoke.invoke({
      body: { ...body, deniedTools: ['create_data_lake'] },
      userId: OWNER_ID,
      authOrigin: 'session',
    });

    expect((invoke as any).questStartParams).toEqual(expect.objectContaining({ deniedTools: ['create_data_lake'] }));
  });
  // Same boundary: dropped here, a key-driven lake write would be audited as the key's owner.
  it('carries the server-set apiKeyId onto questStartParams', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: 'gpt-4', type: 'text', name: 'GPT-4', max_tokens: 100, contextWindow: 1000, pricing: {} },
    ] as any);
    mockDb.quests.create.mockResolvedValue({ id: 'quest-1', promptMeta: {} });
    mockDb.adminSettings.getSettingsValue.mockResolvedValue('text-embedding-ada-002');

    const invoke = makeInvoke();
    await invoke.invoke({ body, userId: OWNER_ID, authOrigin: 'apiKey', apiKeyId: 'key1' });

    expect((invoke as any).questStartParams).toEqual(
      expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'key1' })
    );
  });
  // The positive signal a session-only tool checks; dropped here, the async worker would see none.
  it('carries the server-set authOrigin onto questStartParams', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: 'gpt-4', type: 'text', name: 'GPT-4', max_tokens: 100, contextWindow: 1000, pricing: {} },
    ] as any);
    mockDb.quests.create.mockResolvedValue({ id: 'quest-1', promptMeta: {} });
    mockDb.adminSettings.getSettingsValue.mockResolvedValue('text-embedding-ada-002');

    const invoke = makeInvoke();
    await invoke.invoke({ body, userId: OWNER_ID, authOrigin: 'internal' });

    expect((invoke as any).questStartParams).toEqual(expect.objectContaining({ authOrigin: 'internal' }));
    expect((invoke as any).questStartParams.apiKeyId).toBeUndefined();
  });
  it.each([
    ['a key turn without its key id', { authOrigin: 'apiKey' as const }],
    ['a key id on a session turn', { authOrigin: 'session' as const, apiKeyId: 'key1' }],
    ['a key id on an internal turn', { authOrigin: 'internal' as const, apiKeyId: 'key1' }],
  ])('rejects %s before creating the quest', async (_label, auth) => {
    const invoke = makeInvoke();
    await expect(invoke.invoke({ body, userId: OWNER_ID, ...auth })).rejects.toThrow(/authOrigin/);
    expect(mockDb.quests.create).not.toHaveBeenCalled();
  });
});

// A session pinned to a retired model must reach its DEPRECATED_MODEL_MAP successor. The catalog
// hides or disables such a model, so the redirect has to run before the availability checks.
describe('ChatCompletionInvoke.invoke - deprecated model redirect', () => {
  const OWNER_ID = 'owner-1';
  const HIDDEN_ID = 'claude-3-haiku-20240307';
  const SUCCESSOR_ID = 'claude-haiku-5-5';
  const successor = { id: SUCCESSOR_ID, type: 'text', name: 'Claude Haiku 5.5', max_tokens: 100, contextWindow: 1000 };
  let mockDb: any;

  const makeInvoke = () =>
    new ChatCompletionInvoke({
      db: mockDb,
      logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      user: { id: OWNER_ID, tags: [] } as any,
      invokeLambda: vi.fn(),
    } as any);

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

  beforeEach(() => {
    mockedGetAvailableModels.mockReset();
    mockDb = {
      sessions: {
        findById: vi.fn().mockResolvedValue({ id: 'session-1', userId: OWNER_ID, users: [], agentIds: [] }),
        update: vi.fn(),
      },
      organizations: { findById: vi.fn() },
      quests: {
        findById: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'quest-1', promptMeta: {} }),
        update: vi.fn(),
      },
      adminSettings: {
        getSettingsValue: vi.fn().mockResolvedValue('text-embedding-ada-002'),
        findOne: vi.fn().mockResolvedValue(null),
      },
    };
  });

  afterEach(() => resetReplacedByOverlay());

  const modelConfigs = (configs: unknown[]) =>
    mockDb.adminSettings.findOne.mockResolvedValue({ settingName: 'llmModelConfigurations', settingValue: configs });

  it('redirects a hidden deprecated model to its successor', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' });

    expect((invoke as any).questStartParams).not.toBeNull();
    expect(mockDb.sessions.update).toHaveBeenCalledWith(expect.objectContaining({ lastUsedModel: SUCCESSOR_ID }));
  });

  it('redirects a disabled deprecated model to its successor', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: HIDDEN_ID, type: 'text', name: 'Claude 3 Haiku', disabled: true, disabledReason: 'retired' },
      successor,
    ] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' });

    expect((invoke as any).questStartParams).not.toBeNull();
    expect(mockDb.sessions.update).toHaveBeenCalledWith(expect.objectContaining({ lastUsedModel: SUCCESSOR_ID }));
  });

  it('checks the successor, not the retired id, against model access configuration', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);
    modelConfigs([
      { id: HIDDEN_ID, enabled: true, allowedUserTags: [] },
      { id: SUCCESSOR_ID, enabled: true, allowedUserTags: ['premium'] },
    ]);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' });

    expect((invoke as any).questStartParams).toBeNull();
    expect(mockDb.quests.update).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', reply: expect.stringContaining(`"${SUCCESSOR_ID}" is not accessible`) })
    );
  });

  it('rejects the redirect when the successor is itself disabled', async () => {
    mockedGetAvailableModels.mockResolvedValue([{ ...successor, disabled: true, disabledReason: 'paused' }] as any);

    await expect(
      makeInvoke().invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' })
    ).rejects.toThrow(`Model "${SUCCESSOR_ID}" is currently unavailable: paused`);
    expect(mockDb.quests.create).not.toHaveBeenCalled();
  });

  it('follows a successor chain to its live end and admits only that model', async () => {
    updateReplacedByOverlay({ [HIDDEN_ID]: 'mid-model', 'mid-model': SUCCESSOR_ID });
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' });

    expect((invoke as any).questStartParams).not.toBeNull();
    expect(mockDb.sessions.update).toHaveBeenCalledWith(expect.objectContaining({ lastUsedModel: SUCCESSOR_ID }));
  });

  it('terminates on a successor cycle and rejects when no hop is in the catalog', async () => {
    updateReplacedByOverlay({ [HIDDEN_ID]: 'loop-a', 'loop-a': HIDDEN_ID });
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    await expect(
      makeInvoke().invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' })
    ).rejects.toThrow(/Invalid model/);
  });

  it('does not reroute a retired hidden id for an API-key caller, and names the successor', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    await expect(
      makeInvoke().invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'apiKey', apiKeyId: 'key-1' })
    ).rejects.toThrow(`Invalid model: "${HIDDEN_ID}" is not available; it is replaced by "${SUCCESSOR_ID}"`);
    expect(mockDb.sessions.update).not.toHaveBeenCalled();
  });

  it('does not reroute a retired disabled id for an API-key caller', async () => {
    mockedGetAvailableModels.mockResolvedValue([
      { id: HIDDEN_ID, type: 'text', name: 'Claude 3 Haiku', disabled: true },
      successor,
    ] as any);

    await expect(
      makeInvoke().invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'apiKey', apiKeyId: 'key-1' })
    ).rejects.toThrow(/is replaced by/);
  });

  it('records the retired id in promptMeta.redirectedFrom and labels the reply with the successor', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(HIDDEN_ID), userId: OWNER_ID, authOrigin: 'session' });

    expect(mockDb.quests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMeta: expect.objectContaining({
          redirectedFrom: HIDDEN_ID,
          model: expect.objectContaining({ name: SUCCESSOR_ID, contextWindow: 1000 }),
        }),
      })
    );
  });

  it('records no redirect for a current model', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor(SUCCESSOR_ID), userId: OWNER_ID, authOrigin: 'session' });

    const { promptMeta } = mockDb.quests.create.mock.calls[0][0];
    expect(promptMeta).not.toHaveProperty('redirectedFrom');
    expect(promptMeta.model.name).toBe(SUCCESSOR_ID);
  });

  it('still rejects an unmapped model that is not in the catalog', async () => {
    mockedGetAvailableModels.mockResolvedValue([successor] as any);

    await expect(
      makeInvoke().invoke({ body: bodyFor('no-such-model'), userId: OWNER_ID, authOrigin: 'session' })
    ).rejects.toThrow(/Invalid model/);
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
    await expect(
      invoke.invoke({ body: bodyFor('whisper-1'), userId: OWNER_ID, authOrigin: 'session' })
    ).rejects.toThrow(/cannot run a chat completion/);

    expect(mockDb.sessions.update).not.toHaveBeenCalled();
    expect(mockDb.quests.create).not.toHaveBeenCalled();
  });

  // Media models run through this same path, so the guard must not turn into a text-only gate.
  // questStartParams is asserted rather than the create() argument because it runs the stored
  // promptMeta back through PromptMetaZodSchema - the same enum this write must satisfy.
  it.each(['text', 'image', 'video'])('records %s unchanged on promptMeta.model.type', async type => {
    mockedGetAvailableModels.mockResolvedValue([modelInfo('some-model', type)] as any);

    const invoke = makeInvoke();
    await invoke.invoke({ body: bodyFor('some-model'), userId: OWNER_ID, authOrigin: 'session' });

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
    await invoke.invoke({ body: bodyFor('mystery-model'), userId: OWNER_ID, authOrigin: 'session' });

    expect(mockDb.quests.create).toHaveBeenCalled();
    expect((invoke as any).questStartParams?.promptMeta?.model?.type).toBeUndefined();
  });

  // The tool-calling scorecard (evals/toolCalling) splits stored turns by this field.
  it('records the public API toolMode on promptMeta, and nothing when the request named none', async () => {
    mockedGetAvailableModels.mockResolvedValue([modelInfo('some-model', 'text')] as any);

    const withMode = makeInvoke();
    await withMode.invoke({
      body: { ...bodyFor('some-model'), toolMode: 'smart' },
      userId: OWNER_ID,
      authOrigin: 'session',
    });
    expect((withMode as any).questStartParams?.promptMeta?.toolMode).toBe('smart');

    const withoutMode = makeInvoke();
    await withoutMode.invoke({ body: bodyFor('some-model'), userId: OWNER_ID, authOrigin: 'session' });
    expect((withoutMode as any).questStartParams?.promptMeta).not.toHaveProperty('toolMode');
  });
});
