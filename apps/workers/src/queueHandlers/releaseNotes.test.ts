import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  getSettingsByNames: vi.fn(),
  emitModalGenerationMetrics: vi.fn(),
  upsertGenerated: vi.fn(),
  findWorkspace: vi.fn(),
  generateReleaseNotes: vi.fn(),
  createCompleter: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: h.getSettingsByNames }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  releaseNoteRepository: { upsertGenerated: h.upsertGenerated },
  slackDevWorkspaceRepository: { findBySlackTeamIdWithToken: h.findWorkspace },
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitModalGenerationMetrics: h.emitModalGenerationMetrics }));
vi.mock('./releaseNotes/generate', () => ({
  generateReleaseNotes: h.generateReleaseNotes,
  createReleaseNotesCompleter: h.createCompleter,
}));
vi.stubGlobal('fetch', h.fetch);

import { dispatch } from './releaseNotes';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never as {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};
const run = (...bodies: string[]) =>
  dispatch({ Records: bodies.map((body, i) => ({ body, messageId: `m${i}` })) } as never, {} as never, logger as never);

const validPayload = {
  kind: 'release-notes',
  schemaVersion: 1,
  releaseTag: 'v1.2.3.4',
  releaseUrl: 'https://example.com/releases/v1.2.3.4',
  previousTag: 'v1.2.3.3',
  deployedSha: 'abc123',
  deployedAt: '2026-01-01T00:00:00Z',
  prs: [{ number: 1, title: 'feat: thing', labels: [], excerpt: 'desc' }],
};

const usage = { inputTokens: 1000, outputTokens: 500 };
const draft = (headline = 'Faster search') => ({
  draft: {
    headline,
    summary: 'Search is quicker.',
    items: [{ category: 'improved', text: 'Search is faster', importance: 1, sourcePrs: [1] }],
  },
  usage,
});
const enabledConfig = { enabled: true, denylist: ['acme'], slackTeamId: 'T1', slackChannelId: 'C1' };
const metricNames = () =>
  h.emitModalGenerationMetrics.mock.calls.flatMap(([ms]) => ms.map((m: { name: string }) => m.name));
const slackPosts = () => h.fetch.mock.calls.filter(([url]) => String(url).includes('chat.postMessage'));

const setConfig = (value: unknown) =>
  h.getSettingsByNames.mockResolvedValue({ releaseNotesConfig: value === null ? null : JSON.stringify(value) });

describe('releaseNotes queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({ enabled: false });
    h.createCompleter.mockResolvedValue({ complete: vi.fn(), modelId: 'gpt-4o-mini' });
    h.generateReleaseNotes.mockResolvedValue(draft());
    h.upsertGenerated.mockImplementation(async (note: unknown) => ({ note, preserved: false }));
    h.findWorkspace.mockResolvedValue({ slackBotToken: 'xoxb-test' });
    h.fetch.mockResolvedValue({ json: async () => ({ ok: true }) });
  });

  it('acks and drops a legacy whatsNewGeneration payload with a warning and metric', async () => {
    await expect(run(JSON.stringify({ generatedDate: '2026-01-01', releases: [] }))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('legacy'), expect.anything());
    expect(h.emitModalGenerationMetrics).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'LegacyPayloadDropped', value: 1 }),
    ]);
    expect(h.getSettingsByNames).not.toHaveBeenCalled();
  });

  it('throws on a malformed payload so it lands in the DLQ', async () => {
    await expect(run(JSON.stringify({ kind: 'release-notes', releaseTag: 'v1' }))).rejects.toThrow(
      /invalid job payload/
    );
  });

  it('throws on a body that is not JSON', async () => {
    await expect(run('not json')).rejects.toThrow(SyntaxError);
  });

  it('is a logged no-op when the setting is disabled', async () => {
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('is a no-op when the setting has never been saved', async () => {
    setConfig(null);
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
  });

  it('stores the note, announces it in Slack and emits success metrics', async () => {
    setConfig(enabledConfig);
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();

    expect(h.upsertGenerated).toHaveBeenCalledWith(
      expect.objectContaining({ releaseTag: 'v1.2.3.4', status: 'scheduled', headline: 'Faster search' })
    );
    const posts = slackPosts();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1].body);
    expect(body.channel).toBe('C1');
    expect(body.text).toContain('Goes live in');
    expect(body.text).toContain('Search is faster');
    expect(metricNames()).toEqual(
      expect.arrayContaining(['Success', 'Duration', 'InputTokens', 'OutputTokens', 'EstimatedCost'])
    );
    const cost = h.emitModalGenerationMetrics.mock.calls
      .flatMap(([ms]) => ms)
      .find((m: { name: string }) => m.name === 'EstimatedCost');
    expect(cost.value).toBeGreaterThan(0);
    expect(cost.value).toBeLessThan(0.05);
  });

  it('keeps a human-edited note and skips the announcement', async () => {
    setConfig(enabledConfig);
    h.upsertGenerated.mockImplementation(async (note: object) => ({
      note: { ...note, headline: 'Edited' },
      preserved: true,
    }));
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
    expect(slackPosts()).toHaveLength(0);
    expect(metricNames()).toContain('Success');
  });

  it('still acks when Slack fails, since the note is already stored', async () => {
    setConfig(enabledConfig);
    h.fetch.mockRejectedValue(new Error('network down'));
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
    expect(h.upsertGenerated).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Slack announcement failed'), expect.anything());
  });

  it('does not post when no Slack target is configured', async () => {
    setConfig({ enabled: true });
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
    expect(h.upsertGenerated).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rewrites once when the headline hits the denylist, feeding the reason back', async () => {
    setConfig(enabledConfig);
    h.generateReleaseNotes.mockResolvedValueOnce(draft('Built for Acme')).mockResolvedValueOnce(draft());
    await expect(run(JSON.stringify(validPayload))).resolves.toBeUndefined();
    expect(h.generateReleaseNotes).toHaveBeenCalledTimes(2);
    expect(h.generateReleaseNotes.mock.calls[1][2]).toEqual([expect.stringContaining('acme')]);
    expect(h.upsertGenerated).toHaveBeenCalledWith(expect.objectContaining({ headline: 'Faster search' }));
  });

  it('throws and emits a failure metric when the rewrite still hits the denylist', async () => {
    setConfig(enabledConfig);
    h.generateReleaseNotes.mockResolvedValue(draft('Built for Acme'));
    await expect(run(JSON.stringify(validPayload))).rejects.toThrow(/denylist/);
    expect(h.upsertGenerated).not.toHaveBeenCalled();
    expect(metricNames()).toEqual(['Failure']);
  });

  it('emits a failure metric and rethrows when generation fails', async () => {
    setConfig(enabledConfig);
    h.generateReleaseNotes.mockRejectedValue(new Error('LLM down'));
    await expect(run(JSON.stringify(validPayload))).rejects.toThrow('LLM down');
    expect(metricNames()).toEqual(['Failure']);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
