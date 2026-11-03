import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { TooManyRequestsError } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

// Exercises the Slack quest handler's delivery and video resolver wiring. The chat processor and external
// dependencies are stubbed; the handler's control flow and Slack delivery-target wrapper run unchanged.

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

const processError = new Error('Model context window is smaller than its reserved output');
const mockProcess = vi.fn().mockRejectedValue(processError);
const mockCreateVideoJob = vi.fn();
const mockBuildVideoToolConfig = vi.fn();
const videoAvailability = { marker: 'video-availability' };
const videoCreateDeps = { marker: 'video-create-deps' };

vi.mock('@bike4mind/server-utils/videoGenerations/buildVideoToolConfig', () => ({
  buildVideoToolConfig: (...args: unknown[]) => mockBuildVideoToolConfig(...args),
}));

vi.mock('@server/generationJobs/wiring', () => ({
  getVideoJobDeps: () => videoAvailability,
  getCreateVideoJobDeps: () => videoCreateDeps,
}));

vi.mock('@bike4mind/services/llm', () => ({
  ChatCompletionProcess: class {
    process = mockProcess;
  },
}));

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
    User: { findById: vi.fn(async () => ({ _id: 'user-1', id: 'user-1' })) },
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
    mockBuildVideoToolConfig.mockResolvedValue({ usableModels: ['test-video'], createJob: mockCreateVideoJob });
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

    // The pending notification stays so a successful retry can still replace the notice.
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalledWith(QUEST_ID, { $unset: { slackNotification: 1 } });
  });

  it('forwards the queued authOrigin to process() unchanged', async () => {
    mockProcess.mockResolvedValueOnce(undefined);
    const event = makeEvent() as unknown as { detail: Record<string, unknown> };
    event.detail.authOrigin = 'internal';

    await handler(event as never);

    expect(mockProcess).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ authOrigin: 'internal' }) })
    );
  });

  it('wires the requesting quest and user into the video resolver passed to process', async () => {
    mockProcess.mockImplementationOnce(
      async ({ videoToolConfigResolver }: { videoToolConfigResolver?: () => Promise<VideoToolConfig | null> }) => {
        if (!videoToolConfigResolver) throw new Error('Slack video resolver was not wired');
        const config = await videoToolConfigResolver();
        if (!config) throw new Error('Slack video config was not available');
        await config.createJob({
          user: { id: 'user-1', organizationId: null },
          questId: QUEST_ID,
          source: 'agent',
          request: {},
        });
      }
    );

    await handler(makeEvent());

    const { Quest } = await import('@bike4mind/database');
    expect(Quest.findById).toHaveBeenNthCalledWith(1, QUEST_ID);
    expect(mockBuildVideoToolConfig).toHaveBeenCalledExactlyOnceWith('user-1', {
      availability: videoAvailability,
      createDeps: videoCreateDeps,
    });
    expect(mockBuildVideoToolConfig.mock.calls[0][1].availability).toBe(videoAvailability);
    expect(mockBuildVideoToolConfig.mock.calls[0][1].createDeps).toBe(videoCreateDeps);
    expect(mockCreateVideoJob).toHaveBeenCalledExactlyOnceWith({
      user: { id: 'user-1', organizationId: null },
      questId: QUEST_ID,
      source: 'agent',
      request: {},
      delivery: {
        kind: 'slack',
        workspaceId: slackNotification.workspaceId,
        channelId: slackNotification.channelId,
        threadTs: slackNotification.messageTs,
      },
    });
  });

  it('replaces the failure notice with the answer when a retry succeeds', async () => {
    await expect(handler(makeEvent())).rejects.toThrow(processError.message);

    mockProcess.mockResolvedValueOnce(undefined);
    questDoc = { slackNotification, type: 'completion', reply: 'recovered answer' };
    await handler(makeEvent());

    expect(mockUpdateMessage).toHaveBeenCalledTimes(2);
    const [, retryCall] = mockUpdateMessage.mock.calls.map(([arg]) => arg);
    expect(retryCall.ts).toBe(slackNotification.messageTs);
    expect(retryCall.text).toContain('recovered answer');
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(QUEST_ID, { $unset: { slackNotification: 1 } });
  });

  it('posts confirmation buttons for the stored pending action timestamp', async () => {
    const pendingActionTs = 1_700_000_000_000;
    mockProcess.mockResolvedValueOnce(undefined);
    questDoc = {
      _id: { toString: () => QUEST_ID },
      slackNotification,
      type: 'completion',
      reply: 'Ready to create the issue',
      pendingAction: {
        tool: 'create_issue',
        params: { owner: 'o', repo: 'r', title: 'Confirm flow test' },
        ts: pendingActionTs,
      },
    };

    await handler(makeEvent());

    const [call] = mockUpdateMessage.mock.calls[0];
    const buttonValues = call.blocks
      .flatMap((block: { elements?: Array<{ action_id: string; value: string }> }) => block.elements ?? [])
      .filter((element: { action_id: string }) => ['confirm_action', 'cancel_action'].includes(element.action_id))
      .map((element: { value: string }) => element.value);
    expect(buttonValues).toEqual([`${QUEST_ID}:${pendingActionTs}`, `${QUEST_ID}:${pendingActionTs}`]);
  });

  it('quotes every line of a multi-line error detail', async () => {
    questDoc = { slackNotification, type: 'error', reply: 'first line\nsecond line\r\nthird line' };

    await expect(handler(makeEvent())).rejects.toThrow(processError.message);

    const [call] = mockUpdateMessage.mock.calls[0];
    expect(call.text).toContain('> first line\n> second line\n> third line');
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

  describe('when billing refuses the turn with the free-tier daily cap', () => {
    const capError = new TooManyRequestsError('Daily free-tier credit limit reached. Try again tomorrow.', {
      errorCode: 'daily_free_limit_reached',
      retryAfter: 3600,
    });

    it('consumes the event, still posts the failure notice, and logs at warn', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      mockProcess.mockRejectedValueOnce(capError);
      questDoc = { slackNotification, type: 'error', reply: capError.message };

      await expect(handler(makeEvent())).resolves.toBeUndefined();

      expect(mockUpdateMessage).toHaveBeenCalledTimes(1);
      expect(mockUpdateMessage.mock.calls[0][0].text).toContain(capError.message);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('refused by billing'),
        expect.objectContaining({ questId: QUEST_ID })
      );
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Chat processing failed'), expect.anything());
    });

    it('resolves even when the Slack notice cannot be delivered', async () => {
      mockProcess.mockRejectedValueOnce(capError);
      mockUpdateMessage.mockRejectedValue(new Error('slack down'));

      await expect(handler(makeEvent())).resolves.toBeUndefined();
    });

    it('still logs a generic failure at error and rethrows it', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      await expect(handler(makeEvent())).rejects.toThrow(processError.message);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Chat processing failed'),
        expect.objectContaining({ questId: QUEST_ID })
      );
    });
  });
});
