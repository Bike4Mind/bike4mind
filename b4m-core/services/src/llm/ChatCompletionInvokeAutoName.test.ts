import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same out-of-process collaborators as ChatCompletionInvokeRetryBinding.test.ts.
vi.mock('./modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('./modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('../apiKeyService', () => ({
  getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}),
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: vi.fn().mockResolvedValue([{ id: 'test-model', disabled: false }]),
  resolveSuccessorChain: (id: string) => id,
}));

import { ChatCompletionInvoke } from './ChatCompletionInvoke';

const SESSION = 'session-1';

const makeHarness = ({
  session = {},
  autoNameNotebook = 1,
  autoNameSession = vi.fn().mockResolvedValue(null),
}: {
  session?: Record<string, unknown>;
  autoNameNotebook?: number;
  autoNameSession?: ReturnType<typeof vi.fn>;
} = {}) => {
  const calls: string[] = [];
  autoNameSession.mockImplementation(async () => {
    calls.push('autoName');
    return null;
  });
  const invokeLambda = vi.fn().mockImplementation(async () => {
    calls.push('dispatch');
  });
  const questsUpdate = vi.fn().mockResolvedValue(undefined);

  const db = {
    sessions: {
      findById: vi
        .fn()
        .mockResolvedValue({ id: SESSION, userId: 'user-A', agentIds: [], name: 'New Notebook', ...session }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    quests: {
      findById: vi.fn(),
      update: questsUpdate,
      create: vi.fn().mockImplementation(async (data: Record<string, unknown>) => ({ id: 'quest-1', ...data })),
    },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    adminSettings: {
      getSettingsValue: vi.fn(async (key: string) =>
        key === 'AutoNameNotebook' ? autoNameNotebook : 'text-embedding-3-small'
      ),
      findOne: vi.fn().mockResolvedValue({ settingValue: [] }),
    },
  };

  const options = {
    db,
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    user: { id: 'user-A', isAdmin: false, tags: [] },
    invokeLambda,
    autoNameSession,
  };

  const invoke = new ChatCompletionInvoke(options as unknown as ConstructorParameters<typeof ChatCompletionInvoke>[0]);
  return { invoke, invokeLambda, autoNameSession, questsUpdate, calls };
};

const run = (invoke: ChatCompletionInvoke, message = 'Plan a three-day trip to Kyoto', messageFileIds: string[] = []) =>
  invoke.invoke({
    body: {
      sessionId: SESSION,
      historyCount: 0,
      fabFileIds: [],
      messageFileIds,
      message,
      params: { model: 'test-model' },
    } as never,
    userId: 'user-A',
    authOrigin: 'session',
  });

const dispatchedBody = (invokeLambda: ReturnType<typeof vi.fn>) => invokeLambda.mock.calls[0][0];

describe('ChatCompletionInvoke turn-start auto-naming', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes AutoName for a new notebook before dispatching the turn, and tells the worker', async () => {
    const { invoke, invokeLambda, autoNameSession, calls } = makeHarness();

    await run(invoke);

    expect(autoNameSession).toHaveBeenCalledTimes(1);
    expect(autoNameSession).toHaveBeenCalledWith(SESSION, expect.anything());
    expect(calls).toEqual(['autoName', 'dispatch']);
    expect(dispatchedBody(invokeLambda).autoNameDispatched).toBe(true);
    expect(invoke.autoNameDispatched).toBe(true);
  });

  it('publishes for a notebook still carrying its surface placeholder', async () => {
    const { invoke, autoNameSession } = makeHarness({
      session: { name: 'API chat', autoNamePlaceholder: 'API chat' },
    });

    await run(invoke);

    expect(autoNameSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an already-named notebook', { isAutoNamed: true, name: 'Kyoto Trip Plan' }],
    ['a notebook the user renamed', { name: 'My project' }],
  ])('does not publish for %s', async (_label, session) => {
    const { invoke, invokeLambda, autoNameSession } = makeHarness({ session });

    await run(invoke);

    expect(autoNameSession).not.toHaveBeenCalled();
    expect(dispatchedBody(invokeLambda).autoNameDispatched).toBeUndefined();
    expect(invoke.autoNameDispatched).toBe(false);
  });

  it('does not publish for a low-signal prompt, leaving a later turn to name it', async () => {
    const { invoke, invokeLambda, autoNameSession } = makeHarness();

    await run(invoke, 'Hello');

    expect(autoNameSession).not.toHaveBeenCalled();
    expect(dispatchedBody(invokeLambda).autoNameDispatched).toBeUndefined();
    expect(invoke.autoNameDispatched).toBe(false);
  });

  it('publishes for a short prompt that carries an attachment', async () => {
    const { invoke, autoNameSession } = makeHarness();

    await run(invoke, 'hi', ['file-1']);

    expect(autoNameSession).toHaveBeenCalledTimes(1);
  });

  it('does not publish when AutoNameNotebook is disabled', async () => {
    const { invoke, autoNameSession } = makeHarness({ autoNameNotebook: 0 });

    await run(invoke);

    expect(autoNameSession).not.toHaveBeenCalled();
  });

  it('still runs the turn when the publish fails, leaving the after-reply path to name it', async () => {
    const autoNameSession = vi.fn();
    const { invoke, invokeLambda, questsUpdate } = makeHarness({ autoNameSession });
    autoNameSession.mockRejectedValue(new Error('EventBridge unavailable'));

    const quest = await run(invoke);

    expect(invokeLambda).toHaveBeenCalledTimes(1);
    expect(dispatchedBody(invokeLambda).autoNameDispatched).toBeUndefined();
    expect(invoke.autoNameDispatched).toBe(false);
    expect(quest?.type).toBe('message');
    expect(questsUpdate).not.toHaveBeenCalled();
  });
});
