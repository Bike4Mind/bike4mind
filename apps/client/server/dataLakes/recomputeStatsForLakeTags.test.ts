import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The per-lake fan-out, which has two properties that are easy to break by accident and that nothing
 * else in the repo pins: the lakes are recomputed CONCURRENTLY, and one failing lake does not stop
 * the others. The second is what makes the first safe - `Promise.all` rejects on the first rejection,
 * so hoisting the try/catch out of the map would silently turn "skip that lake" into "skip every
 * remaining lake" on file DELETE, bulk-delete, and every S3 upload-completion.
 *
 * `extractDataLakeMetaTags` is stubbed rather than exercised: normalization and dedup belong to
 * authorizeLakeWrite and are tested there, so the inputs here are already-distinct meta tags.
 */

const h = vi.hoisted(() => ({
  findByDatalakeTag: vi.fn(),
  recomputeLakeStats: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
  fabFileRepository: { __repo: 'fabFiles' },
  // lakeConfigAuditDb freezes these at import time, so they have to exist on the mocked module.
  lakeConfigChangeEventRepository: { record: vi.fn() },
  adminSettingsRepository: { findBySettingNames: vi.fn(), findAll: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    extractDataLakeMetaTags: (names: readonly unknown[]) =>
      (names as string[]).filter(n => typeof n === 'string' && n.startsWith('datalake:')),
    recomputeLakeStats: h.recomputeLakeStats,
  },
}));

import { recomputeStatsForLakeTags } from './recomputeStatsForLakeTags';

const TAGS = ['datalake:alpha', 'datalake:beta', 'datalake:gamma'];
const logger = { error: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.findByDatalakeTag.mockImplementation(async (tag: string) => ({
    id: tag.replace('datalake:', ''),
    datalakeTag: tag,
  }));
  h.recomputeLakeStats.mockResolvedValue(undefined);
});

describe('recomputeStatsForLakeTags', () => {
  it('recomputes every named lake exactly once', async () => {
    await recomputeStatsForLakeTags(TAGS, { logger });

    expect(h.recomputeLakeStats).toHaveBeenCalledTimes(3);
    expect(h.recomputeLakeStats.mock.calls.map(c => (c[0] as { id: string }).id).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  // Fails by TIMING OUT rather than asserting, and that is the point: every lake blocks on a gate
  // that only opens once all three have started, so a sequential implementation can never reach the
  // third and deadlocks. A passing run proves they were genuinely in flight together.
  it('starts every lake before any of them finishes', async () => {
    let started = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    h.recomputeLakeStats.mockImplementation(async () => {
      started += 1;
      if (started === TAGS.length) open();
      await gate;
    });

    await recomputeStatsForLakeTags(TAGS, { logger });

    expect(started).toBe(TAGS.length);
  });

  it('keeps recomputing the other lakes when one of them throws', async () => {
    h.findByDatalakeTag.mockImplementation(async (tag: string) => {
      if (tag === 'datalake:beta') throw new Error('lake lookup exploded');
      return { id: tag.replace('datalake:', ''), datalakeTag: tag };
    });

    await recomputeStatsForLakeTags(TAGS, { logger });

    expect(h.recomputeLakeStats.mock.calls.map(c => (c[0] as { id: string }).id).sort()).toEqual(['alpha', 'gamma']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error recomputing'), {
      error: expect.any(Error),
      metaTag: 'datalake:beta',
    });
  });

  it('skips a meta-tag whose lake no longer exists without disturbing the rest', async () => {
    h.findByDatalakeTag.mockImplementation(async (tag: string) =>
      tag === 'datalake:beta' ? null : { id: tag.replace('datalake:', ''), datalakeTag: tag }
    );

    await recomputeStatsForLakeTags(TAGS, { logger });

    expect(h.recomputeLakeStats.mock.calls.map(c => (c[0] as { id: string }).id).sort()).toEqual(['alpha', 'gamma']);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
