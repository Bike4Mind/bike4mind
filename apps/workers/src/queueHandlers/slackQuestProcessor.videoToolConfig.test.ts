import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Drives getSlackVideoToolConfigResolver the way the handler passes it to ChatCompletionProcess.process:
// only the thin edges (config, event bus, DB models, video wiring) are stubbed.

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

vi.mock('@bike4mind/server-utils/utils/config', () => ({
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

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({ download: vi.fn() }),
}));

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getSharedTokenizer: () => ({}),
  publishTelemetryAlertCallback: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: () => 'xoxb-decrypted',
}));

let questDoc: Record<string, unknown> | null = null;

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    Quest: { findById: vi.fn(async () => questDoc) },
  };
});

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

const mockCreateJob = vi.fn().mockResolvedValue({ ok: true });
const mockBuildVideoToolConfig = vi.fn();

vi.mock('@bike4mind/server-utils/videoGenerations/buildVideoToolConfig', () => ({
  buildVideoToolConfig: (...args: unknown[]) => mockBuildVideoToolConfig(...args),
}));

vi.mock('@server/generationJobs/wiring', () => ({
  getVideoJobDeps: () => ({ marker: 'video-job-deps' }),
  getCreateVideoJobDeps: () => ({ marker: 'create-video-job-deps' }),
}));

const slackNotification = {
  workspaceId: 'workspace-1',
  channelId: 'C123',
  messageTs: '1700000000.000200',
  threadTs: '1700000000.000100',
};

const jobInput = { user: { id: 'user-1', organizationId: null }, request: {}, source: 'agent' as const };

describe('getSlackVideoToolConfigResolver', () => {
  // The handler's transitive import graph (services + database + slack) is heavy enough
  // that resolving it inside a test blows the default timeout.
  let getSlackVideoToolConfigResolver: typeof import('./slackQuestProcessor').getSlackVideoToolConfigResolver;

  beforeAll(async () => {
    ({ getSlackVideoToolConfigResolver } = await import('./slackQuestProcessor'));
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    questDoc = { slackNotification };
    mockBuildVideoToolConfig.mockResolvedValue({ usableModels: ['test-video'], createJob: mockCreateJob });
  });

  it('does not offer the tool when the quest has no pending Slack notification', async () => {
    questDoc = {};
    await expect(getSlackVideoToolConfigResolver('quest-1', 'user-1')()).resolves.toBeNull();
    expect(mockBuildVideoToolConfig).not.toHaveBeenCalled();
  });

  it('does not offer the tool when the quest is gone', async () => {
    questDoc = null;
    await expect(getSlackVideoToolConfigResolver('quest-1', 'user-1')()).resolves.toBeNull();
  });

  it('does not offer the tool when the user has no usable video model', async () => {
    mockBuildVideoToolConfig.mockResolvedValue(null);
    await expect(getSlackVideoToolConfigResolver('quest-1', 'user-1')()).resolves.toBeNull();
  });

  it("builds the config for the quest's user and stamps the requesting thread on the jobs it creates", async () => {
    const config = await getSlackVideoToolConfigResolver('quest-1', 'user-1')();
    expect(mockBuildVideoToolConfig).toHaveBeenCalledWith('user-1', {
      availability: { marker: 'video-job-deps' },
      createDeps: { marker: 'create-video-job-deps' },
    });
    await config?.createJob(jobInput);
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: {
          kind: 'slack',
          workspaceId: 'workspace-1',
          channelId: 'C123',
          threadTs: slackNotification.threadTs,
        },
      })
    );
    expect(config?.deliveryNote).toEqual(expect.stringContaining('Slack thread'));
  });

  it('threads under the triggering message when the request was not in a thread', async () => {
    const { threadTs: _unused, ...topLevel } = slackNotification;
    questDoc = { slackNotification: topLevel };
    const config = await getSlackVideoToolConfigResolver('quest-1', 'user-1')();
    await config?.createJob(jobInput);
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: expect.objectContaining({ threadTs: slackNotification.messageTs }) })
    );
  });
});
