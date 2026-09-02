import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors recomputeStatsForLakeTags.test.ts: the same per-lake fan-out, the same two properties
 * that are easy to break by accident - concurrent, and one failing lake does not stop the rest -
 * plus two properties specific to this helper: a per-lake failure is swallowed, not rethrown,
 * because the destruction has already converged and the receipt is already filed by the time this
 * runs (see the docstring on shredMemoryForLakeTags); and the purging lake is shredded from
 * `purgingLake` directly, deduped against (not layered on top of) whatever the tag-based lookup
 * also resolves it to.
 *
 * `findMemberLakesForFile` is exercised for real here, not stubbed: it is pure given the two
 * repository methods below, and stubbing its membership resolution would hide exactly the
 * two-arm logic this helper exists to get right.
 */

const h = vi.hoisted(() => ({
  findByDatalakeTag: vi.fn(),
  find: vi.fn(),
  shredMemoryFromSource: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, find: h.find },
  memoryLedgerRepository: { __repo: 'memoryLedger' },
}));
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return { dataLakeService: actual.dataLakeService };
});
vi.mock('@server/memory/ledgerMemoryStore', () => ({
  shredMemoryFromSource: h.shredMemoryFromSource,
}));

import { shredMemoryForLakeTags } from './shredMemoryForLakeTags';

const TAGS = ['datalake:alpha', 'datalake:beta', 'datalake:gamma'];
const FAB_FILE_ID = 'file-1';
const OWNER_ID = 'file-owner';
const PURGING_LAKE = { id: 'purging', datalakeTag: 'datalake:purging', createdByUserId: 'purging-owner' };
const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  h.findByDatalakeTag.mockImplementation(async (tag: string) => ({
    id: tag.replace('datalake:', ''),
    datalakeTag: tag,
    createdByUserId: `${tag.replace('datalake:', '')}-owner`,
  }));
  // No lakes owned by the file's owner match the prefix arm unless a test says otherwise.
  h.find.mockResolvedValue([]);
  h.shredMemoryFromSource.mockResolvedValue(0);
});

describe('shredMemoryForLakeTags', () => {
  it('shreds every named lake exactly once, plus the purging lake', async () => {
    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger });

    expect(h.shredMemoryFromSource).toHaveBeenCalledTimes(4);
    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { kind: string; id: string }).id).sort()).toEqual([
      'datalake:alpha',
      'datalake:beta',
      'datalake:gamma',
      'datalake:purging',
    ]);
  });

  it('shreds the purging lake only once when it also resolves through the tag lookup', async () => {
    // The file itself carries the purging lake's own meta-tag - the common case for a meta-tag
    // member. `purgingLake.id` matching what the lookup resolves is what triggers the dedupe.
    await shredMemoryForLakeTags(['datalake:purging', 'datalake:beta'], FAB_FILE_ID, OWNER_ID, PURGING_LAKE, {
      logger,
    });

    expect(h.shredMemoryFromSource).toHaveBeenCalledTimes(2);
    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:beta',
      'datalake:purging',
    ]);
  });

  it('shreds a lake the file joined only through the owner-anchored prefix arm', async () => {
    // No datalake:* tag names it at all - only findMemberLakesForFile's prefix-arm query surfaces it.
    h.find.mockResolvedValue([
      {
        id: 'prefix-lake',
        datalakeTag: 'datalake:prefix-lake',
        createdByUserId: 'prefix-owner',
        fileTagPrefix: 'eng:',
      },
    ]);

    await shredMemoryForLakeTags(['eng:spec'], FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger });

    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:prefix-lake',
      'datalake:purging',
    ]);
  });

  // Fails by TIMING OUT rather than asserting, and that is the point: every lake blocks on a gate
  // that only opens once all four have started, so a sequential implementation can never reach the
  // last and deadlocks. A passing run proves they were genuinely in flight together.
  it('starts every lake before any of them finishes', async () => {
    const total = TAGS.length + 1;
    let started = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      open = resolve;
    });
    h.shredMemoryFromSource.mockImplementation(async () => {
      started += 1;
      if (started === total) open();
      await gate;
      return 0;
    });

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger });

    expect(started).toBe(total);
  });

  it('still shreds the purging lake when resolving the other member lakes fails entirely', async () => {
    // findMemberLakesForFile has no per-tag catch of its own: one meta-tag lookup throwing fails
    // the whole bulk resolution, not just that one lake. The purging lake needs no lookup at all,
    // so it must survive a failure that costs every OTHER lake its shred this call.
    h.findByDatalakeTag.mockImplementation(async (tag: string) => {
      if (tag === 'datalake:beta') throw new Error('lake lookup exploded');
      return { id: tag.replace('datalake:', ''), datalakeTag: tag, createdByUserId: 'owner-1' };
    });

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger });

    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:purging',
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[lakeMemory] failed to resolve the document's other member lakes; shredding only the purging lake",
      expect.objectContaining({ fabFileId: FAB_FILE_ID })
    );
  });

  it('skips a meta-tag whose lake no longer exists without disturbing the rest', async () => {
    h.findByDatalakeTag.mockImplementation(async (tag: string) =>
      tag === 'datalake:beta'
        ? null
        : { id: tag.replace('datalake:', ''), datalakeTag: tag, createdByUserId: 'owner-1' }
    );

    await shredMemoryForLakeTags(TAGS, FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger });

    expect(h.shredMemoryFromSource.mock.calls.map(c => (c[1] as { id: string }).id).sort()).toEqual([
      'datalake:alpha',
      'datalake:gamma',
      'datalake:purging',
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a failing shred rather than rethrowing, since the destruction already converged', async () => {
    h.shredMemoryFromSource.mockImplementation(async (_repo: unknown, source: { id: string }) => {
      if (source.id === 'datalake:beta') throw new Error('ledger unreachable');
      return 0;
    });

    await expect(
      shredMemoryForLakeTags(TAGS, FAB_FILE_ID, OWNER_ID, PURGING_LAKE, { logger })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      '[lakeMemory] failed to shred a purged document facts on one lake',
      expect.objectContaining({ fabFileId: FAB_FILE_ID })
    );
  });
});
