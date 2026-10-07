import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  getSettingsByNames: vi.fn(),
  emitModalGenerationMetrics: vi.fn(),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: h.getSettingsByNames }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@server/utils/cloudwatch', () => ({ emitModalGenerationMetrics: h.emitModalGenerationMetrics }));

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

const setConfig = (value: unknown) =>
  h.getSettingsByNames.mockResolvedValue({ releaseNotesConfig: value === null ? null : JSON.stringify(value) });

describe('releaseNotes queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({ enabled: false });
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

  it('throws when enabled, keeping the message replayable until generation is wired', async () => {
    setConfig({ enabled: true });
    await expect(run(JSON.stringify(validPayload))).rejects.toThrow(/not wired/);
  });
});
