import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import { dispatch } from './whatsNewHighlights';
import { AdminSettings, releaseNoteRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { loadReleaseNotesConfig } from '@server/releaseNotes/adminReleaseNotes';

vi.mock('@bike4mind/database', () => ({
  releaseNoteRepository: { findPublishedBetween: vi.fn() },
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

// Only the stored config is stubbed; the denylist matching is the real helper.
vi.mock('@server/releaseNotes/adminReleaseNotes', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/releaseNotes/adminReleaseNotes')>();
  return { ...actual, loadReleaseNotesConfig: vi.fn() };
});

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

const note = {
  id: 'note-1',
  releaseTag: 'v2026.10.01',
  headline: 'Faster uploads',
  summary: 'Uploads got sturdier.',
  items: [
    { category: 'improved', text: 'Large uploads resume after a dropped connection', importance: 1 },
    { category: 'fixed', text: 'Upload progress no longer stalls at 99%', importance: 2 },
  ],
  publishAt: new Date('2026-10-01T00:00:00Z'),
};

const mockNotes = (notes: unknown[]) => {
  vi.mocked(releaseNoteRepository.findPublishedBetween).mockResolvedValue(notes as never);
};

const mockReleaseNotesConfig = (config: { enabled: boolean; denylist?: string[] }, malformed = false) => {
  vi.mocked(loadReleaseNotesConfig).mockResolvedValue({
    config: { denylist: [], ...config },
    malformed,
  } as never);
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
    mockReleaseNotesConfig({ enabled: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the generated highlights to Slack, attaches the markdown, and records success', async () => {
    mockNotes([note]);

    await dispatch(eventFor(basePayload), context);

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toBe(ChatModels.GPT4o_MINI);
    const prompt = complete.mock.calls[0][1][0].content;
    expect(prompt).toContain('Faster uploads');
    expect(prompt).toContain('v2026.10.01');
    expect(prompt).toContain('Large uploads resume after a dropped connection');

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
    mockNotes([note]);
    mockConfig({ attachMarkdownFile: false });

    await dispatch(eventFor(basePayload), context);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['https://slack.com/api/chat.postMessage']);
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('success');
  });

  it('falls back to the default model when the configured one is not a known model', async () => {
    mockNotes([note]);
    mockConfig({ llmModel: 'not-a-real-model' });

    await dispatch(eventFor(basePayload), context);

    expect(complete.mock.calls[0][0]).toBe(ChatModels.GPT4o_MINI);
  });

  it('records no_modals and posts a release-notes warning without calling the LLM when none were published', async () => {
    mockNotes([]);

    await dispatch(eventFor(basePayload), context);

    expect(getLlmByModel).not.toHaveBeenCalled();
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('no_modals');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://slack.com/api/chat.postMessage');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer decrypted:enc-token');
    expect(JSON.parse(init.body as string).text).toContain('No release notes were published');
  });

  it('queries through the end of a date-only endDate, capped at now', async () => {
    mockNotes([note]);

    await dispatch(eventFor(basePayload), context);

    const [start, end, now] = vi.mocked(releaseNoteRepository.findPublishedBetween).mock.calls[0];
    expect(start.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-04T23:59:59.999Z');
    expect(now).toBeInstanceOf(Date);
  });

  it.each([
    ['disabled', { enabled: false }, false],
    ['malformed', { enabled: true }, true],
  ])(
    'records skipped and posts a notice without querying or calling the LLM when release notes are %s',
    async (_label, config, malformed) => {
      mockReleaseNotesConfig(config, malformed);
      mockNotes([note]);

      await dispatch(eventFor(basePayload), context);

      expect(releaseNoteRepository.findPublishedBetween).not.toHaveBeenCalled();
      expect(getLlmByModel).not.toHaveBeenCalled();
      expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('skipped');
      expect(fetchMock).toHaveBeenCalledOnce();
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string).text).toContain('release notes are disabled');
    }
  );

  it('withholds a release note that matches the denylist from the prompt', async () => {
    mockReleaseNotesConfig({ enabled: true, denylist: ['sturdier'] });
    mockNotes([note, { ...note, id: 'note-2', releaseTag: 'v2026.10.02', headline: 'Dark mode', summary: '' }]);

    await dispatch(eventFor(basePayload), context);

    const prompt = complete.mock.calls[0][1][0].content;
    expect(prompt).toContain('Dark mode');
    expect(prompt).not.toContain('Faster uploads');
  });

  it('does not post to Slack when no channel is configured', async () => {
    mockNotes([note]);

    await dispatch(eventFor({ correlationId: 'corr-1', environment: 'dev' }), context);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastStatusUpdate()?.['settingValue.lastStatus']).toBe('success');
  });

  it('records failed, emits the failure metric and rethrows so the message reaches the DLQ', async () => {
    mockNotes([note]);
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

    expect(releaseNoteRepository.findPublishedBetween).not.toHaveBeenCalled();
  });
});
