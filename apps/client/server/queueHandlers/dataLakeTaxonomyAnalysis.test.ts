import { describe, it, expect, vi, beforeEach } from 'vitest';

// Passthrough the wrapper so we drive the raw handler directly.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  analyzeBatchTaxonomy: vi.fn(),
  setTaxonomyStatusIfActive: vi.fn(),
}));
vi.mock('@server/dataLakes/analyzeBatchTaxonomy', () => ({ analyzeBatchTaxonomy: h.analyzeBatchTaxonomy }));
vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive },
}));

import { dispatch } from './dataLakeTaxonomyAnalysis';

const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const makeEvent = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as never;
const payload = { batchId: 'b1', dataLakeId: 'lake1', userId: 'u1' };

describe('dataLakeTaxonomyAnalysis consumer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to the shared orchestration, claiming only from queued', async () => {
    h.analyzeBatchTaxonomy.mockResolvedValue({ claimed: true, outcome: 'ready' });

    await dispatch(makeEvent(payload), {} as never, logger);

    expect(h.analyzeBatchTaxonomy).toHaveBeenCalledWith('b1', 'lake1', 'u1', logger, { from: ['queued'] });
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });

  it('logs (but does not throw) when the claim is already taken - a harmless redelivery/reconciler race', async () => {
    h.analyzeBatchTaxonomy.mockResolvedValue({ claimed: false });

    await expect(dispatch(makeEvent(payload), {} as never, logger)).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalled();
  });

  it('swallows a malformed message instead of retrying it to the DLQ', async () => {
    await expect(dispatch(makeEvent({ userId: 'u1' }), {} as never, logger)).resolves.toBeUndefined();
    expect(h.analyzeBatchTaxonomy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  // This is the actual regression: the guarded claim leaves the batch at 'analyzing', which
  // blocks every SQS redelivery attempt from re-claiming - so without releasing it back to
  // 'queued' first, "let SQS retry" was a no-op and the real error was discarded in favor of
  // the reconciler's generic timeout message ~10 minutes later.
  it('releases the claim back to queued before rethrowing an unexpected error, so SQS redelivery can actually retry', async () => {
    const boom = new Error('mongo down');
    h.analyzeBatchTaxonomy.mockRejectedValue(boom);
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });

    await expect(dispatch(makeEvent(payload), {} as never, logger)).rejects.toThrow('mongo down');

    // The taxonomyStartedAt refresh matters: without it, a batch waiting between ordinary SQS
    // redeliveries (up to ~2x the queue's 6-minute visibility timeout) would read as stale
    // against its ORIGINAL claim time once the stuck-job reconciler's staleness guard runs off
    // this field, and could get force-failed mid-retry instead of actually getting retried.
    const [, , , extra] = h.setTaxonomyStatusIfActive.mock.calls[0];
    expect(extra.taxonomyStartedAt.getTime()).toBeCloseTo(Date.now(), -2);
  });

  it('does not attempt to release a claim that was never taken (payload failed to parse)', async () => {
    await expect(dispatch(makeEvent({ userId: 'u1' }), {} as never, logger)).resolves.toBeUndefined();
    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  });
});
