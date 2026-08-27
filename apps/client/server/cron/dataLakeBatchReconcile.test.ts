import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findStuck: vi.fn(),
  reconcile: vi.fn(),
  findStuckTaxonomy: vi.fn(),
  reconcileTaxonomy: vi.fn(),
  recordForced: vi.fn(),
  recordGauge: vi.fn(),
  recordRun: vi.fn(),
  enqueueTaxonomyAnalysisIfWanted: vi.fn(),
  getSettingsValue: vi.fn(),
  fabFileFind: vi.fn(),
  sendToQueue: vi.fn(),
  // Hoisted rather than left inside the observability mock's closure: an SST cron's return value is
  // discarded by EventBridge, so this log line is the only actionable output the rescue sweep's
  // per-file catch produces. Unexposed, deleting that logger.error call is undetectable.
  loggerError: vi.fn(),
  // Spied (not a bare stub) so a test can assert the cron passes BOTH the age cutoff and the
  // stale-claim cutoff: a one-arg call silently turns the stale-claim rescue arm back off.
  buildScanFilter: vi.fn((cutoff: Date, _staleClaimBefore: Date) => ({ chunkCount: 0, createdAt: { $lt: cutoff } })),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  dataLakeBatchRepository: { findStuck: h.findStuck, findStuckTaxonomy: h.findStuckTaxonomy },
  dataLakeRepository: {},
  fabFileRepository: {},
  // getSettingsValue for this cron's own flags, plus the retention pair the config-audit
  // resolver reads - one declaration serving both consumers (see lakeConfigAuditDb).
  adminSettingsRepository: {
    getSettingsValue: h.getSettingsValue,
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  // Wired by this cron now that it records the auto-activate it can cause. Stubbed rather than
  // omitted: this mock replaces the whole module, so an unlisted export fails at import time.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  FabFile: { find: h.fabFileFind },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    DEFAULT_STUCK_BATCH_TIMEOUT_MS: 180 * 60 * 1000,
    reconcileStuckBatches: h.reconcile,
    DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS: 10 * 60 * 1000,
    reconcileStuckTaxonomy: h.reconcileTaxonomy,
  },
}));
vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: h.loggerError, log: vi.fn() };
  mockLogger.withMetadata = vi.fn(() => mockLogger);
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%', STAGE: 'dev' } }));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' }, fabFileChunkQueue: { url: 'http://sqs/fabFileChunkQueue' } },
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: (...a: unknown[]) => h.sendToQueue(...a) }));
// Only the filter is stubbed (so the call args are assertable); the payload builder stays real so
// these tests pin the provenance the sweep actually sends.
vi.mock('@server/worker/chunkScan', async importActual => ({
  ...(await importActual<typeof import('@server/worker/chunkScan')>()),
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date])),
}));
vi.mock('@server/utils/cloudwatch', () => ({
  recordReconcilerForcedTerminal: (...a: unknown[]) => h.recordForced(...a),
  recordStuckBatchGauge: (...a: unknown[]) => h.recordGauge(...a),
  recordReconcileRun: (...a: unknown[]) => h.recordRun(...a),
}));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({
  enqueueTaxonomyAnalysisIfWanted: (...a: unknown[]) => h.enqueueTaxonomyAnalysisIfWanted(...a),
}));

import { handler } from './dataLakeBatchReconcile';

const TIMEOUT = 180 * 60 * 1000;

describe('dataLakeBatchReconcile cron handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.recordRun.mockResolvedValue(undefined);
    h.recordForced.mockResolvedValue(undefined);
    h.recordGauge.mockResolvedValue(undefined);
    h.findStuckTaxonomy.mockResolvedValue([]);
    h.reconcileTaxonomy.mockResolvedValue([]);
    h.enqueueTaxonomyAnalysisIfWanted.mockResolvedValue(undefined);
    // Rescue sweep defaults: auto-chunk off, no candidates, sends succeed. The send stub is reset
    // explicitly because clearAllMocks() clears calls but NOT implementations - without this a test
    // that makes sendToQueue reject leaks that into every test after it in file order.
    h.getSettingsValue.mockResolvedValue(false);
    h.sendToQueue.mockResolvedValue(undefined);
    h.fabFileFind.mockReturnValue({
      select: () => ({ limit: () => ({ lean: async () => [] }) }),
    });
  });

  it('scans with a cutoff ~ now-timeout and a bounded limit, reconciles, and heartbeats', async () => {
    h.findStuck.mockResolvedValue([{ id: 'b1', dataLakeId: 'lake1' }]);
    h.reconcile.mockResolvedValue(['b1']);

    const before = Date.now();
    const res = await handler();
    const after = Date.now();

    expect(h.findStuck).toHaveBeenCalledTimes(1);
    const [cutoff, limit] = h.findStuck.mock.calls[0] as [Date, number];
    expect(limit).toBe(500);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - TIMEOUT - 5000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - TIMEOUT + 5000);

    expect(h.reconcile).toHaveBeenCalledWith(
      [{ id: 'b1', dataLakeId: 'lake1' }],
      TIMEOUT,
      expect.objectContaining({
        // The config-audit repos, named rather than covered by expect.anything(): this sweep forces
        // terminal exactly the batches that never reached finalizeBatchIfComplete, so it is the only
        // path that can activate those lakes. Both keys are optional on the service, so a sweep that
        // stopped spreading lakeConfigAuditDb would record nothing and still pass every other
        // assertion in this file.
        db: expect.objectContaining({
          lakeConfigChangeEvents: expect.objectContaining({ record: expect.any(Function) }),
          adminSettings: expect.objectContaining({ findBySettingNames: expect.any(Function) }),
        }),
        metrics: expect.objectContaining({
          emitForcedTerminal: expect.any(Function),
          emitStuckGauge: expect.any(Function),
        }),
      })
    );
    expect(h.recordRun).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      candidates: 1,
      forced: 1,
      taxonomyCandidates: 0,
      taxonomyForced: 0,
      rescuedChunkFiles: 0,
      rescueFailures: 0,
    });
  });

  it('heartbeats even when nothing is stuck (zero-work run)', async () => {
    h.findStuck.mockResolvedValue([]);
    h.reconcile.mockResolvedValue([]);
    const res = await handler();
    expect(h.recordRun).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body)).toEqual({
      candidates: 0,
      forced: 0,
      taxonomyCandidates: 0,
      taxonomyForced: 0,
      rescuedChunkFiles: 0,
      rescueFailures: 0,
    });
  });

  it('wires metric hooks that route to the CloudWatch helpers and swallow a rejecting helper', async () => {
    h.findStuck.mockResolvedValue([]);
    h.reconcile.mockResolvedValue([]);
    await handler();

    // The hooks are passed to reconcile but only invoked BY the reconciler, so capture and drive
    // them here to prove they route to the right helper and don't escape on a rejected emit.
    const { metrics } = (h.reconcile.mock.calls[0] as unknown[])[2] as {
      metrics: {
        emitForcedTerminal: (batch: { id: string; dataLakeId: string }) => Promise<void>;
        emitStuckGauge: (n: number) => Promise<void>;
      };
    };
    const forcedBatch = { id: 'b1', dataLakeId: 'lake1', wantsTaxonomy: true };
    await metrics.emitForcedTerminal(forcedBatch);
    await metrics.emitStuckGauge(3);
    expect(h.recordForced).toHaveBeenCalledTimes(1);
    expect(h.recordGauge).toHaveBeenCalledWith(3);
    // Backstops the taxonomy enqueue for a batch that never reached upload-complete.
    expect(h.enqueueTaxonomyAnalysisIfWanted).toHaveBeenCalledWith(forcedBatch, expect.anything());

    h.recordForced.mockRejectedValueOnce(new Error('cloudwatch down'));
    await expect(metrics.emitForcedTerminal({ id: 'b2', dataLakeId: 'lake2' })).resolves.toBeUndefined();
  });

  describe('un-chunked rescue sweep (#1420)', () => {
    beforeEach(() => {
      h.findStuck.mockResolvedValue([]);
      h.reconcile.mockResolvedValue([]);
    });

    it('CLAIMS then re-enqueues only the ids it won, tagging each with its claim token', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      h.fabFileFind.mockReturnValue({
        select: () => ({
          limit: () => ({
            lean: async () => [
              { _id: 'ff1', userId: 'u1' }, // plain upload, no lake batch
              { _id: 'ff2', userId: 'u2', batchId: 'batch-9' }, // data-lake file
            ],
          }),
        }),
      });
      // The CAS claim wins both files, each with its stamp; the sweep enqueues only won ids.

      const res = await handler();

      // The scan filter must receive BOTH the age cutoff AND the stale-claim cutoff; a one-arg call
      // (or the wrong Date) silently drops the stale-claim rescue arm. staleClaimBefore is the older
      // of the two (30-min stale window vs 2-min age cutoff).
      expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
      const [cutoff, staleClaimBefore] = h.buildScanFilter.mock.calls[0] as [Date, Date];
      expect(cutoff).toBeInstanceOf(Date);
      expect(staleClaimBefore).toBeInstanceOf(Date);
      expect(staleClaimBefore.getTime()).toBeLessThan(cutoff.getTime());

      // Only won ids are enqueued (never the raw pre-read set), and each carries its claim token so
      // the worker can reject a duplicate/superseded delivery.
      expect(h.sendToQueue).toHaveBeenCalledTimes(2);
      // EVERY message is stamped convergence, with or without a batch: a scheduled sweep is
      // background work, so it must stay haltable by the kill switch. An un-stamped re-enqueue
      // reads as `user` and would re-chunk a file the switch had just parked as paused.
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff1',
        userId: 'u1',
        origin: 'convergence',
      });
      // A global sweep carries no lakeId, so only the platform-scope switch halts it.
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff2',
        userId: 'u2',
        origin: 'convergence',
      });
      expect(JSON.parse(res.body).rescuedChunkFiles).toBe(2);
    });

    it('enqueues every id the filter selected - duplicates are the worker CAS to resolve', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      h.fabFileFind.mockReturnValue({
        select: () => ({
          limit: () => ({
            lean: async () => [
              { _id: 'ff1', userId: 'u1' },
              { _id: 'ff2', userId: 'u2' },
            ],
          }),
        }),
      });

      const res = await handler();

      // No producer-side claim: the sweep sends what its filter selected, and a file already in
      // flight loses the chunk worker's compare-and-set and returns without re-chunking.
      expect(h.sendToQueue).toHaveBeenCalledTimes(2);
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff1',
        userId: 'u1',
        origin: 'convergence',
      });
      expect(JSON.parse(res.body).rescuedChunkFiles).toBe(2);
    });

    it('finishes the sweep when one enqueue fails, and reports the partial result (#2117)', async () => {
      // The sweep is the safety net for files the chunk pipeline lost, so it matters most under the
      // cluster/queue stress that makes a transient send failure likely. It used to reject out of the
      // loop on the first failure: every candidate behind it was abandoned, and because the caller
      // turns a throw into 0 it also reported a sweep that HAD rescued files as having rescued none.
      h.getSettingsValue.mockResolvedValue(true);
      h.fabFileFind.mockReturnValue({
        select: () => ({
          limit: () => ({
            lean: async () => [
              { _id: 'ff1', userId: 'u1' },
              { _id: 'ff2', userId: 'u2' },
              { _id: 'ff3', userId: 'u3' },
              { _id: 'ff4', userId: 'u4' },
            ],
          }),
        }),
      });
      // TWO fail, and neither is first or last: the middle placement distinguishes "kept going" from
      // "stopped early", and the second failure is what forces `failed` to accumulate - a counter
      // pinned to 1 would satisfy a single-failure fixture.
      h.sendToQueue.mockImplementation(async (_url: unknown, msg: { fabFileId: string }) => {
        if (msg.fabFileId === 'ff2' || msg.fabFileId === 'ff3') throw new Error('SQS throttled');
      });

      const res = await handler();

      // All four attempted - the ones behind a failure are not abandoned.
      expect(h.sendToQueue).toHaveBeenCalledTimes(4);
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff4',
        userId: 'u4',
        origin: 'convergence',
      });
      // And the counts are honest: two really were rescued, two really were not.
      const body = JSON.parse(res.body);
      expect(body.rescuedChunkFiles).toBe(2);
      expect(body.rescueFailures).toBe(2);
      // Each failure names its file. The cron's return value goes nowhere (EventBridge discards it),
      // so without this line an operator has no way to tell WHICH files were not enqueued.
      for (const fabFileId of ['ff2', 'ff3']) {
        expect(h.loggerError).toHaveBeenCalledWith(
          expect.stringContaining('failed to enqueue'),
          expect.objectContaining({ fabFileId, error: 'SQS throttled' })
        );
      }
    });

    it('does not let a rescue failure take down the batch reconciliation around it', async () => {
      // The isolation the caller's catch already provided must survive the per-item catch: the
      // stuck-batch sweep above it still reports, and the handler still returns 200.
      h.getSettingsValue.mockResolvedValue(true);
      h.fabFileFind.mockReturnValue({
        select: () => ({ limit: () => ({ lean: async () => [{ _id: 'ff1', userId: 'u1' }] }) }),
      });
      h.sendToQueue.mockRejectedValue(new Error('queue unreachable'));

      const res = await handler();

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.rescuedChunkFiles).toBe(0);
      expect(body.rescueFailures).toBe(1);
    });

    it('does nothing when auto-chunk is disabled', async () => {
      h.getSettingsValue.mockResolvedValue(false);
      await handler();
      expect(h.fabFileFind).not.toHaveBeenCalled();
      expect(h.sendToQueue).not.toHaveBeenCalled();
    });

    it('a rescue failure is isolated: the run still heartbeats and reports 0', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      h.fabFileFind.mockImplementation(() => {
        throw new Error('mongo down');
      });

      const res = await handler();

      expect(h.recordRun).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      // BOTH counts, not just the rescued one: the outer catch has to return a whole
      // {enqueued, failed}, and a fallback that omits `failed` reports nothing at all here -
      // JSON.stringify drops the undefined key, so the field silently vanishes from the body.
      const body = JSON.parse(res.body);
      expect(body.rescuedChunkFiles).toBe(0);
      expect(body.rescueFailures).toBe(0);
    });
  });
});
