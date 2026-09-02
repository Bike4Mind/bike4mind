import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors recomputeStatsForLakeTags.test.ts: the same per-lake fan-out, the same two properties
 * that are easy to break by accident - concurrent, and one failing lake does not stop the rest -
 * plus the one property specific to this helper: a per-lake failure is swallowed, not rethrown,
 * because the destruction has already converged and the receipt is already filed by the time
 * this runs (see the docstring on shredMemoryForLakeTags).
 */

const h = vi.hoisted(() => ({
  findByDatalakeTag: vi.fn(),
  shredMemoryFromSource: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag },
  memoryLedgerRepository: { __repo: 'memoryLedger' },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    extractDataLakeMetaTags: (names: readonly unknown[]) =>
      (names as string[]).filter(n => typeof n === 'string' && n.startsWith('datalake:')),
  },
}));
vi.mock('@server/memory/ledgerMemoryStore', () => ({
  shredMemoryFromSource: h.shredMemoryFromSource,
}));

import { shredMemoryForLakeTags } from './shredMemoryForLakeTags';

const TAGS = ['datalake:alpha', 'datalake:beta', 'datalake:gamma'];
const FAB_FILE_ID = 'file-1';
const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.findByDatalakeTag.mockImplementation(async (tag: string) => ({
    id: tag.replace('datalake:', ''),
    datalakeTag: tag,
    createdByUserId: `${tag.replace('datalake:', '')}-owner`,
  }));
  h.shredMemoryFromSource.mockResolvedValue(0);
});

describe('shredMemoryForLakeTags', () => {
  it('shreds every named lake exactly once', async () => {
    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, { logger });

    expect(h.shredMemoryFromSource).toHaveBeenCalledTimes(3);
    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { kind: string; id: string }).id).sort()).toEqual([
      'datalake:alpha',
      'datalake:beta',
      'datalake:gamma',
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
    h.shredMemoryFromSource.mockImplementation(async () => {
      started += 1;
      if (started === TAGS.length) open();
      await gate;
      return 0;
    });

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, { logger });

    expect(started).toBe(TAGS.length);
  });

  it('keeps shredding the other lakes when one of them throws', async () => {
    h.findByDatalakeTag.mockImplementation(async (tag: string) => {
      if (tag === 'datalake:beta') throw new Error('lake lookup exploded');
      return { id: tag.replace('datalake:', ''), datalakeTag: tag, createdByUserId: 'owner-1' };
    });

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, { logger });

    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:alpha',
      'datalake:gamma',
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[lakeMemory] failed to shred a purged document facts on one lake',
      expect.objectContaining({ metaTag: 'datalake:beta', fabFileId: FAB_FILE_ID })
    );
  });

  it('skips a meta-tag whose lake no longer exists without disturbing the rest', async () => {
    h.findByDatalakeTag.mockImplementation(async (tag: string) =>
      tag === 'datalake:beta'
        ? null
        : { id: tag.replace('datalake:', ''), datalakeTag: tag, createdByUserId: 'owner-1' }
    );

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, { logger });

    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:alpha',
      'datalake:gamma',
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a failing shred rather than rethrowing, since the destruction already converged', async () => {
    h.shredMemoryFromSource.mockImplementation(async (_repo: unknown, source: { id: string }) => {
      if (source.id === 'datalake:beta') throw new Error('ledger unreachable');
      return 0;
    });

    await expect(shredMemoryForLakeTags(TAGS, FAB_FILE_ID, { logger })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      '[lakeMemory] failed to shred a purged document facts on one lake',
      expect.objectContaining({ metaTag: 'datalake:beta' })
    );
  });
});
