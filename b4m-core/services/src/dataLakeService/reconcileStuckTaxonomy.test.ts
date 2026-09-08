import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeBatchDocument } from '@bike4mind/common';
import { reconcileStuckTaxonomy, DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS } from './reconcileStuckTaxonomy';

const batch = (overrides: Partial<IDataLakeBatchDocument> = {}): IDataLakeBatchDocument =>
  ({
    id: 'b1',
    dataLakeId: 'lake1',
    taxonomyStatus: 'analyzing',
    taxonomyStartedAt: new Date(0),
    ...overrides,
  }) as IDataLakeBatchDocument;

describe('reconcileStuckTaxonomy - guarded stuck-job reconciliation', () => {
  it('forces a stuck analyzing job to failed', async () => {
    const forceFailStuckTaxonomy = vi.fn().mockResolvedValue(batch({ taxonomyStatus: 'failed' }));
    const now = DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS + 10_000;

    const forced = await reconcileStuckTaxonomy(
      [batch()],
      DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS,
      { db: { batches: { forceFailStuckTaxonomy } } },
      now
    );

    expect(forceFailStuckTaxonomy).toHaveBeenCalledWith(
      'b1',
      ['queued', 'analyzing', 'applying'],
      new Date(now - DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS),
      expect.any(String)
    );
    expect(forced).toEqual(['b1']);
  });

  it('leaves a recently-started job alone', async () => {
    const forceFailStuckTaxonomy = vi.fn();
    const recent = batch({ taxonomyStartedAt: new Date(1000) });

    const forced = await reconcileStuckTaxonomy(
      [recent],
      DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS,
      { db: { batches: { forceFailStuckTaxonomy } } },
      2000
    );

    expect(forceFailStuckTaxonomy).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });

  it('ignores batches that never opted in, or already finished (ready/applied/failed)', async () => {
    const forceFailStuckTaxonomy = vi.fn();
    const now = DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS + 10_000;

    const forced = await reconcileStuckTaxonomy(
      [
        batch({ id: 'none', taxonomyStatus: 'none' }),
        batch({ id: 'ready', taxonomyStatus: 'ready' }),
        batch({ id: 'applied', taxonomyStatus: 'applied' }),
        batch({ id: 'failed', taxonomyStatus: 'failed' }),
      ],
      DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS,
      { db: { batches: { forceFailStuckTaxonomy } } },
      now
    );

    expect(forceFailStuckTaxonomy).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });

  it('does not report a forced id when the guarded transition is lost (a real completion won first)', async () => {
    const forceFailStuckTaxonomy = vi.fn().mockResolvedValue(null);
    const now = DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS + 10_000;

    const forced = await reconcileStuckTaxonomy(
      [batch()],
      DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS,
      { db: { batches: { forceFailStuckTaxonomy } } },
      now
    );

    expect(forced).toEqual([]);
  });

  it('does not report a forced id when the DB-level staleness guard loses to a fresh re-claim', async () => {
    // The in-memory `stuck` filter only proves the batch looked stale in the snapshot read -
    // forceFailStuckTaxonomy is the guard that actually matters at write time. Mock it losing
    // (null), simulating a real re-claim bumping taxonomyStartedAt between the reconciler's
    // read and its write - the exact race this repository method exists to close.
    const forceFailStuckTaxonomy = vi.fn().mockResolvedValue(null);
    const now = DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS + 10_000;

    const forced = await reconcileStuckTaxonomy(
      [batch()], // snapshot still shows the old, stale taxonomyStartedAt
      DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS,
      { db: { batches: { forceFailStuckTaxonomy } } },
      now
    );

    expect(forceFailStuckTaxonomy).toHaveBeenCalledTimes(1);
    expect(forced).toEqual([]);
  });
});
