import { describe, it, expect, vi } from 'vitest';
// The same module instance the handler imports, so the assertion below pins identity, not a copy.
import { premiumWorkspaceDeniedTools } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceDeniedTools.generated';
import { premiumWorkspaceSessionSettings } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceSessionSettings.generated';

const mockProcess = vi.hoisted(() => vi.fn());
const processOptions = vi.hoisted(() => vi.fn());
const mockCapCheck = vi.hoisted(() => vi.fn());

// This exercises only the db-adapter assembly in getStaticOptions: the surface
// save_content_to_data_lake (-> saveContentAdapters in adapters.ts) reads from. Mocks mirror
// apps/workers/src/queueHandlers/slackQuestProcessor.failureNotice.test.ts, which already proves this
// import chain resolves with this mock set - only the thin edges (config, event bus, DB models, storage) are stubbed.

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get() {
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-${String(key)}`,
  }),
}));

vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: { CompletionCompleted: { publish: vi.fn() } },
  SessionEvents: { AutoName: { publish: vi.fn() } },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({ download: vi.fn() }),
}));

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getSharedTokenizer: () => ({}),
  publishTelemetryAlertCallback: vi.fn(),
}));

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    ChatCompletionProcess: class {
      constructor(options: unknown) {
        processOptions(options);
      }
      process = mockProcess;
    },
  };
});

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    Quest: { findOne: vi.fn(() => ({ sort: () => null })) },
    Session: { findById: vi.fn(async () => ({ userId: 'user-1' })) },
    User: { findById: vi.fn(async () => ({ _id: 'user-1' })) },
    sessionRepository: { findById: vi.fn(async () => ({ id: 'session-1' })) },
  };
});

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

vi.mock('@server/billing/freeTierDailyCapGate', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/billing/freeTierDailyCapGate')>()),
  checkFreeTierDailySpendCap: mockCapCheck,
}));

vi.mock('@bike4mind/server-utils/videoGenerations/buildVideoToolConfig', () => ({
  buildVideoToolConfig: vi.fn(async () => ({ usableModels: ['test-video'], createJob: vi.fn() })),
}));

describe('questProcessor getVideoToolConfigResolver', () => {
  it('offers no video resolver on an API-key turn', async () => {
    const { getVideoToolConfigResolver } = await import('./questProcessor');
    expect(getVideoToolConfigResolver('key-1', 'u1')).toBeUndefined();
  }, 120_000);

  it('offers a video resolver on a session turn', async () => {
    const { getVideoToolConfigResolver } = await import('./questProcessor');
    const { buildVideoToolConfig } = await import('@bike4mind/server-utils/videoGenerations/buildVideoToolConfig');
    const resolver = getVideoToolConfigResolver(undefined, 'u1');
    expect(resolver).toBeTypeOf('function');
    await resolver?.();
    expect(buildVideoToolConfig).toHaveBeenCalledWith('u1', expect.anything());
  }, 120_000);
});

vi.mock('@bike4mind/server-utils/musicGenerations/buildMusicToolConfig', () => ({
  buildMusicToolConfig: vi.fn(async () => ({ usableModels: ['test-music'], createJob: vi.fn() })),
}));

describe('questProcessor getMusicToolConfigResolver', () => {
  it('offers no music resolver on an API-key turn', async () => {
    const { getMusicToolConfigResolver } = await import('./questProcessor');
    expect(getMusicToolConfigResolver('key-1', 'u1')).toBeUndefined();
  }, 120_000);

  it('offers a music resolver on a session turn', async () => {
    const { getMusicToolConfigResolver } = await import('./questProcessor');
    const { buildMusicToolConfig } = await import('@bike4mind/server-utils/musicGenerations/buildMusicToolConfig');
    const resolver = getMusicToolConfigResolver(undefined, 'u1');
    expect(resolver).toBeTypeOf('function');
    await resolver?.();
    expect(buildMusicToolConfig).toHaveBeenCalledWith('u1', expect.anything());
  }, 120_000);
});

describe('questProcessor getStaticOptions', () => {
  it('wires the shared operational billing adapter into tool execution', async () => {
    const { getStaticOptions } = await import('./questProcessor');
    const { operationalBillingAdapters } = await import('@server/billing/operationalBilling');

    expect(getStaticOptions().db.operationalBilling).toBe(operationalBillingAdapters);
  }, 120_000);

  it('wires the save_content_to_data_lake audit adapters', async () => {
    // The handler's transitive import graph (services + database + slack) is heavy enough
    // that resolving it inside a test can exceed the default timeout.
    const { getStaticOptions } = await import('./questProcessor');

    const { db } = getStaticOptions();

    // Without any one of these, saveContentAdapters() in
    // b4m-core/services/src/llm/tools/implementation/dataLakeContent/adapters.ts returns null and
    // the tool answers NOT_AVAILABLE instead of saving.
    expect(db.lakeMembershipRemovals).toBeDefined();
    expect(db.lakeConfigChangeEvents).toBeDefined();
    expect(db.lakeMembershipChangeEvents).toBeDefined();
  }, 120_000);

  // This factory is hand-maintained (unlike the shared defaults), so losing the table here
  // silently re-opens every surface denial on this route only.
  it('carries the contributed surface denials into the options', async () => {
    const { getStaticOptions } = await import('./questProcessor');

    expect(getStaticOptions().workspaceDeniedTools).toBe(premiumWorkspaceDeniedTools);
    expect(getStaticOptions().workspaceSessionSettings).toBe(premiumWorkspaceSessionSettings);
  }, 120_000);
});

describe('processQuest', () => {
  it('forwards the queued authOrigin and apiKeyId to process() unchanged', async () => {
    const { processQuest } = await import('./questProcessor');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
    const params = {
      userId: 'user-1',
      sessionId: 'session-1',
      questId: 'quest-1',
      params: {},
      authOrigin: 'apiKey',
      apiKeyId: 'k1',
    };

    await processQuest(params as never, logger as never);

    expect(mockProcess).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'k1' }) })
    );
  }, 120_000);

  it.each([
    ['withholds the admin role when the payload says so', true, false],
    ['keeps the stored role for a payload without the field', undefined, true],
  ])(
    '%s',
    async (_, adminRoleWithheld, expected) => {
      const { User } = await import('@bike4mind/database');
      vi.mocked(User.findById).mockResolvedValueOnce({ _id: 'user-1', isAdmin: true } as never);
      const { processQuest } = await import('./questProcessor');
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
      processOptions.mockClear();
      mockCapCheck.mockImplementationOnce(({ user }: { user: { isAdmin?: boolean } }) => {
        expect(user.isAdmin).toBe(true);
      });

      await processQuest(
        { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {}, adminRoleWithheld } as never,
        logger as never
      );

      expect(processOptions.mock.calls[0][0].user.isAdmin).toBe(expected);
      expect(mockCapCheck).toHaveBeenCalled();
    },
    120_000
  );

  it.each([
    ['withholds every admin_ tool when the admin role is withheld', true, false],
    ['injects the admin tools for an admin without the withheld flag', undefined, true],
  ])(
    '%s',
    async (_, adminRoleWithheld, expectsAdminTools) => {
      const { User } = await import('@bike4mind/database');
      vi.mocked(User.findById).mockResolvedValueOnce({ _id: 'user-1', isAdmin: true } as never);
      const { processQuest } = await import('./questProcessor');
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
      mockProcess.mockClear();

      await processQuest(
        { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {}, adminRoleWithheld } as never,
        logger as never
      );

      expect(mockProcess).toHaveBeenCalledTimes(1);
      const externalToolNames = Object.keys(mockProcess.mock.lastCall?.[0].externalTools ?? {});
      const adminToolNames = externalToolNames.filter(name => name.startsWith('admin_'));
      if (expectsAdminTools) {
        expect(adminToolNames).toContain('admin_get_usage_signals');
      } else {
        expect(adminToolNames).toEqual([]);
      }
    },
    120_000
  );

  it.each([undefined, 'team-org'])(
    'forwards the quest billing organization %s to the daily cap',
    async organizationId => {
      const { processQuest } = await import('./questProcessor');
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

      await processQuest(
        { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {}, organizationId } as never,
        logger as never
      );

      expect(mockCapCheck).toHaveBeenLastCalledWith(expect.objectContaining({ billingOrganizationId: organizationId }));
      expect(mockProcess).toHaveBeenLastCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ organizationId }) })
      );
    },
    120_000
  );

  it('settles a capped quest with the limit message instead of throwing or calling the model', async () => {
    const { DAILY_FREE_LIMIT_REACHED_ERROR_CODE, TooManyRequestsError } = await import('@bike4mind/common');
    const { questRepository } = await import('@bike4mind/database');
    const settle = vi.spyOn(questRepository, 'settleIfUnfinished').mockResolvedValue(true);
    const capError = new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
      errorCode: DAILY_FREE_LIMIT_REACHED_ERROR_CODE,
    });
    mockCapCheck.mockRejectedValueOnce(capError);
    mockProcess.mockClear();
    const { processQuest } = await import('./questProcessor');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

    await expect(
      processQuest(
        { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {} } as never,
        logger as never
      )
    ).resolves.toBeUndefined();

    expect(settle).toHaveBeenCalledWith('quest-1', {
      status: 'stopped',
      type: 'error',
      reply: capError.message,
      replies: [capError.message],
    });
    expect(mockProcess).not.toHaveBeenCalled();
    settle.mockRestore();
  }, 120_000);

  it('still throws an unrelated error from the cap check', async () => {
    mockCapCheck.mockRejectedValueOnce(new Error('boom'));
    const { processQuest } = await import('./questProcessor');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };

    await expect(
      processQuest(
        { userId: 'user-1', sessionId: 'session-1', questId: 'quest-1', params: {} } as never,
        logger as never
      )
    ).rejects.toThrow('boom');
  }, 120_000);
});
