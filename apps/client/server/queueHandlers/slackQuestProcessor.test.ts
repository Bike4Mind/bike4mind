import { describe, it, expect, vi } from 'vitest';

// This exercises only the db-adapter assembly in getStaticOptions: the surface
// save_content_to_data_lake (-> saveContentAdapters in adapters.ts) reads from. Mocks mirror
// slackQuestProcessor.failureNotice.test.ts - only the thin edges (config, event bus, DB
// models, Slack client) are stubbed.

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

vi.mock('@server/integrations/slack/slackPackageInit', () => ({
  initializeSlackPackage: vi.fn(),
}));

vi.mock('@server/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-${String(key)}`,
  }),
}));

vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: {
    SlackCompletionStart: { schema: { parse: (v: unknown) => v } },
    CompletionCompleted: { publish: vi.fn() },
  },
  SessionEvents: { AutoName: { publish: vi.fn() } },
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({ download: vi.fn() }),
}));

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getSharedTokenizer: () => ({}),
  publishTelemetryAlertCallback: vi.fn(),
}));

vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: () => 'xoxb-decrypted',
}));

vi.mock('@bike4mind/services/llm', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services/llm')>('@bike4mind/services/llm');
  return {
    ...actual,
    ChatCompletionProcess: class {
      process = vi.fn();
    },
  };
});

vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return {
    ...actual,
    SlackClient: class {
      updateMessage = vi.fn();
      uploadFile = vi.fn();
    },
  };
});

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    Quest: {
      findById: vi.fn(),
      findByIdAndUpdate: vi.fn(),
      findOne: vi.fn(() => ({ sort: () => null })),
    },
    Session: { findById: vi.fn(async () => ({ userId: 'user-1' })) },
    User: { findById: vi.fn(async () => ({ _id: 'user-1' })) },
    sessionRepository: { findById: vi.fn(async () => ({ id: 'session-1' })) },
    slackDevWorkspaceRepository: { findByIdWithCredentials: vi.fn() },
  };
});

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

describe('slackQuestProcessor getStaticOptions', () => {
  it('wires the save_content_to_data_lake audit adapters', async () => {
    // The handler's transitive import graph (services + database + slack) is heavy enough
    // that resolving it inside a test can exceed the default timeout.
    const { getStaticOptions } = await import('./slackQuestProcessor');

    const { db } = getStaticOptions();

    // Without any one of these, saveContentAdapters() in
    // b4m-core/services/src/llm/tools/implementation/dataLakeContent/adapters.ts returns null and
    // the tool answers NOT_AVAILABLE instead of saving.
    expect(db.lakeMembershipRemovals).toBeDefined();
    expect(db.lakeConfigChangeEvents).toBeDefined();
    expect(db.lakeMembershipChangeEvents).toBeDefined();
  }, 120_000);
});
