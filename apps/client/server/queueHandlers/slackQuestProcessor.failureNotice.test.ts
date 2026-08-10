import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// This exercises the error path of the Slack quest handler: chatCompletion.process()
// throws, so the normal delivery block below it never runs. Only the thin edges are
// stubbed (config, event bus, DB models, Slack client) - the handler's own control flow
// is the thing under test.

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

const processError = new Error('Model context window is smaller than its reserved output');
const mockProcess = vi.fn().mockRejectedValue(processError);

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    ChatCompletionProcess: class {
      process = mockProcess;
    },
  };
});

const mockUpdateMessage = vi.fn().mockResolvedValue(undefined);
const mockUploadFile = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/slack', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/slack')>('@bike4mind/slack');
  return {
    ...actual,
    SlackClient: class {
      updateMessage = mockUpdateMessage;
      uploadFile = mockUploadFile;
    },
  };
});

const QUEST_ID = 'quest-1';

const slackNotification = {
  workspaceId: 'workspace-1',
  channelId: 'C123',
  messageTs: '1700000000.000100',
};

let questDoc: Record<string, unknown> | null = null;
const mockFindByIdAndUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    Quest: {
      findById: vi.fn(async () => questDoc),
      findByIdAndUpdate: (...args: unknown[]) => mockFindByIdAndUpdate(...args),
      findOne: vi.fn(() => ({ sort: () => null })),
    },
    Session: { findById: vi.fn(async () => ({ userId: 'user-1' })) },
    User: { findById: vi.fn(async () => ({ _id: 'user-1' })) },
    sessionRepository: { findById: vi.fn(async () => ({ id: 'session-1' })) },
    slackDevWorkspaceRepository: {
      findByIdWithCredentials: vi.fn(async () => ({ name: 'Test WS', slackBotToken: 'encrypted' })),
    },
  };
});

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

function makeEvent() {
  return {
    'detail-type': 'slack.completion.started',
    detail: { userId: 'user-1', sessionId: 'session-1', questId: QUEST_ID, params: {} },
  } as never;
}

describe('slackQuestProcessor failure notice', () => {
  // The handler's transitive import graph (services + database + slack) is heavy enough
  // that resolving it inside a test blows the default timeout.
  let handler: (event: never) => Promise<void>;

  beforeAll(async () => {
    ({ handler } = await import('./slackQuestProcessor'));
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess.mockRejectedValue(processError);
    mockUpdateMessage.mockResolvedValue(undefined);
    mockFindByIdAndUpdate.mockResolvedValue(undefined);
    questDoc = { slackNotification, type: 'error', reply: processError.message };
  });

  it('replaces the pending Slack status message when chat processing throws', async () => {
    await expect(handler(makeEvent())).rejects.toThrow(processError.message);

    expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
    const [call] = mockUpdateMessage.mock.calls[0];
    expect(call.channel).toBe(slackNotification.channelId);
    expect(call.ts).toBe(slackNotification.messageTs);
    expect(call.text).toContain('something went wrong');
    expect(call.text).toContain(processError.message);

    // The pending notification is cleared so a retry cannot double-post.
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(QUEST_ID, { $unset: { slackNotification: 1 } });
  });

  it('omits the detail line when the quest carries no error reply', async () => {
    questDoc = { slackNotification };

    await expect(handler(makeEvent())).rejects.toThrow(processError.message);

    const [call] = mockUpdateMessage.mock.calls[0];
    expect(call.text).toContain('something went wrong');
    expect(call.text).not.toContain(processError.message);
  });

  it('still rethrows the original error when the Slack notice cannot be delivered', async () => {
    mockUpdateMessage.mockRejectedValue(new Error('slack down'));

    await expect(handler(makeEvent())).rejects.toThrow(processError.message);
  });

  it('does not post a failure notice for a quest with no pending Slack notification', async () => {
    questDoc = { type: 'error', reply: processError.message };

    await expect(handler(makeEvent())).rejects.toThrow(processError.message);

    expect(mockUpdateMessage).not.toHaveBeenCalled();
  });
});
