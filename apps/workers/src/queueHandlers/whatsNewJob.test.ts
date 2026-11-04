import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  emitModalGenerationMetrics: vi.fn(),
  runReleaseNotesJob: vi.fn(),
  runHighlightsJob: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitModalGenerationMetrics: h.emitModalGenerationMetrics,
}));
vi.mock('./releaseNotes', () => ({ runReleaseNotesJob: h.runReleaseNotesJob }));
vi.mock('./whatsNewHighlights', () => ({ runHighlightsJob: h.runHighlightsJob }));

import { dispatch } from './whatsNewJob';

const logger = { warn: vi.fn(), updateMetadata: vi.fn() };
const run = (...bodies: string[]) =>
  dispatch({ Records: bodies.map((body, i) => ({ body, messageId: `m${i}` })) } as never, {} as never, logger as never);

const releaseNotes = {
  kind: 'release-notes',
  schemaVersion: 1,
  releaseTag: 'v1.2.3.4',
  releaseUrl: 'https://example.com/releases/v1.2.3.4',
  previousTag: null,
  deployedSha: 'abc123',
  deployedAt: '2026-01-01T00:00:00Z',
  prs: [],
};
const highlights = { kind: 'highlights', correlationId: 'c1', environment: 'production' };

describe('whatsNewJob dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes release-notes only to the release-notes job', async () => {
    await run(JSON.stringify(releaseNotes));
    expect(h.runReleaseNotesJob).toHaveBeenCalledTimes(1);
    expect(h.runReleaseNotesJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'release-notes', releaseTag: 'v1.2.3.4' }),
      logger
    );
    expect(h.runHighlightsJob).not.toHaveBeenCalled();
    expect(logger.updateMetadata).toHaveBeenCalledWith({ kind: 'release-notes' });
  });

  it('routes highlights only to the highlights job', async () => {
    await run(JSON.stringify(highlights));
    expect(h.runHighlightsJob).toHaveBeenCalledTimes(1);
    expect(h.runHighlightsJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'highlights', correlationId: 'c1' }),
      logger
    );
    expect(h.runReleaseNotesJob).not.toHaveBeenCalled();
    expect(logger.updateMetadata).toHaveBeenCalledWith({ kind: 'highlights' });
  });

  it('acks and drops a legacy generatedDate body with the metric', async () => {
    await expect(run(JSON.stringify({ generatedDate: '2026-01-01', releases: [] }))).resolves.toBeUndefined();
    expect(h.emitModalGenerationMetrics).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'LegacyPayloadDropped', value: 1 }),
    ]);
    expect(h.runReleaseNotesJob).not.toHaveBeenCalled();
    expect(h.runHighlightsJob).not.toHaveBeenCalled();
  });

  it('throws for a highlights body without kind so it reaches the DLQ', async () => {
    await expect(run(JSON.stringify({ correlationId: 'c1', environment: 'production' }))).rejects.toThrow(
      'invalid job payload'
    );
    expect(h.runHighlightsJob).not.toHaveBeenCalled();
  });

  it('throws on invalid JSON', async () => {
    await expect(run('{not json')).rejects.toThrow();
  });
});
