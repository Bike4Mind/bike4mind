import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import { dispatch } from './whatsNewHighlights';
import { AdminSettings, ModalModel, slackDevWorkspaceRepository } from '@bike4mind/database';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';

vi.mock('@bike4mind/database', () => ({
  ModalModel: { find: vi.fn() },
  AdminSettings: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  slackDevWorkspaceRepository: { findBySlackTeamIdWithToken: vi.fn() },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({ openai: 'sk-test' }) },
}));

vi.mock('@bike4mind/observability', () => {
  // any: Logger has many optional methods; a partial mock is simpler than satisfying the full interface.
  const mockLogger: any = {
    info: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    updateMetadata: vi.fn(),
  };
  mockLogger.withMetadata = vi.fn(() => mockLogger);
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: vi.fn(), getLlmByModel: vi.fn() };
});

vi.mock('@server/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: (value: string | null | undefined) => (value ? `decrypted:${value}` : null),
}));

const context = { functionName: 'whats-new-highlights', awsRequestId: 'req-1' } as unknown as Context;

const eventFor = (payload: Record<string, unknown>): SQSEvent =>
  ({ Records: [{ messageId: 'm-1', body: JSON.stringify(payload) }] }) as unknown as SQSEvent;

const basePayload = {
  correlationId: 'corr-1',
  environment: 'dev',
  startDate: '2026-09-28',
  endDate: '2026-10-04',
  slackChannelId: 'C123',
  slackTeamId: 'T123',
};

const modal = {
  _id: { toString: () => 'modal-1' },
  title: 'Faster uploads',
  subtitle: 'Uploads resume',
  description: 'Large uploads now resume after a dropped connection.',
  createdAt: new Date('2026-10-01T00:00:00Z'),
};

const mockModals = (modals: unknown[]) => {
  const query = { sort: vi.fn(), select: vi.fn(), lean: vi.fn().mockResolvedValue(modals) };
  query.sort.mockReturnValue(query);
  query.select.mockReturnValue(query);
  vi.mocked(ModalModel.find).mockReturnValue(query as unknown as ReturnType<typeof ModalModel.find>);
};

const mockConfig = (settingValue: Record<string, unknown> | null) => {
  vi.mocked(AdminSettings.findOne).mockResolvedValue(settingValue ? ({ settingValue } as never) : null);
};

const complete = vi.fn();

const lastStatusUpdate = () => {
  const calls = vi.mocked(AdminSettings.findOneAndUpdate).mock.calls;
  return (calls.at(-1)?.[1] as { $set: Record<string, unknown> } | undefined)?.$set;
};

const fetchMock = vi.fn();

const slackOk = (extra: Record<string, unknown> = {}) => ({ ok: true, json: async () => ({ ok: true, ...extra }) });

describe('whatsNewHighlights queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('getUploadURLExternal')
        ? slackOk({ upload_url: 'https://files.slack.test/upload', file_id: 'F1' })
        : slackOk({ ts: '1.2', channel: 'C123' })
    );
    vi.mocked(slackDevWorkspaceRepository.findBySlackTeamIdWithToken).mockResolvedValue({
      slackBotToken: 'enc-token',
    } as never);
    vi.mocked(getAvailableModels).mockResolvedValue([{ id: ChatModels.GPT4o_MINI }] as never);
    complete.mockImplementation(async (_model, _messages, _options, onChunk) => {
      await onChunk(['## Highlights\n', '- Faster uploads']);
    });
    vi.mocked(getLlmByModel).mockReturnValue({ complete } as never);
    mockConfig(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the generated highlights to Slack, attaches the markdown, and records success', async () => {
    mockModals([modal]);

    await dispatch(eventFor(basePayload), context);

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toBe(ChatModels.GPT4o_MINI);
    expect(complete.mock.calls[0][1][0].content).toContain('Faster uploads');

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'https://slack.com/api/chat.postMessage',
      expect.stringContaining('https://slack.com/api/files.getUploadURLExternal?'),
      'https://files.slack.test/upload',
      'https://slack.com/api/files.completeUploadExternal',
    ]);
    const postInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((postInit.headers as Record<string, string>).Authorization).toBe('Bearer decrypted:enc-token');
    expect(JSON.parse(postInit.body as string).channel).toBe('C123');

    expect(lastStatusUpdate()).toMatchObject({
      'settingValue.lastStatus': 'success',
      'settingValue.lastHighlights': '## Highlights\n- Faster uploads',
      'settingValue.lastCorrelationId': 'corr-1',
    });
    const metricNames = vi
      .mocked(emitModalGenerationMetrics)
      .mock.calls.flatMap(([metrics]) => metrics.map(m => m.name));
    expect(metricNames).toEqual(['HighlightsSuccess', 'HighlightsDuration']);
  });

  it('skips the markdown snippet when attachMarkdownFile is false', async () => {
    mockModals([modal]);
    mockConfig({ attachMarkdownFile: false });

    await dispatch(eventFor(basePayload), context);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['https://slack.com/api/chat.postMessage']);
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('success');
  });

  it('falls back to the default model when the configured one is not a known model', async () => {
    mockModals([modal]);
    mockConfig({ llmModel: 'not-a-real-model' });

    await dispatch(eventFor(basePayload), context);

    expect(complete.mock.calls[0][0]).toBe(ChatModels.GPT4o_MINI);
  });

  it('records no_modals and posts a warning without calling the LLM when the range has no modals', async () => {
    mockModals([]);

    await dispatch(eventFor(basePayload), context);

    expect(getLlmByModel).not.toHaveBeenCalled();
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('no_modals');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).text).toContain(
      "No What's New modals found"
    );
  });

  it('does not post to Slack when no channel is configured', async () => {
    mockModals([modal]);

    await dispatch(eventFor({ correlationId: 'corr-1', environment: 'dev' }), context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('success');
  });

  it('records failed, emits the failure metric and rethrows so the message reaches the DLQ', async () => {
    mockModals([modal]);
    complete.mockRejectedValue(new Error('provider down'));

    await expect(dispatch(eventFor(basePayload), context)).rejects.toThrow('provider down');

    expect(lastStatusUpdate()).toMatchObject({
      'settingValue.lastStatus': 'failed',
      'settingValue.lastCorrelationId': 'corr-1',
    });
    expect(vi.mocked(emitModalGenerationMetrics).mock.calls.at(-1)?.[0][0]).toMatchObject({
      name: 'HighlightsFailure',
      dimensions: { environment: 'dev', errorType: 'Error' },
    });
  });

  it('rejects a payload that fails schema validation', async () => {
    await expect(dispatch(eventFor({ environment: 'staging' }), context)).rejects.toThrow();

    expect(ModalModel.find).not.toHaveBeenCalled();
  });
});
