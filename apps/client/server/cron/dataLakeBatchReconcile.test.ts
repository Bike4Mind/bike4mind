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
  // stale-claim cutoff: a one-arg call silently turns the stale-claim rescue arm back off. The third
  // parameter is here for the same reason - dropping it silently strands paused files (#2120).
  buildScanFilter: vi.fn((cutoff: Date, _staleClaimBefore?: Date, _opts?: unknown) => ({
    chunkCount: 0,
    createdAt: { $lt: cutoff },
  })),
  buildStrandedFilter: vi.fn((cutoff: Date, _staleClaimBefore?: Date) => ({
    vectorizeEnqueueFailedAt: { $lt: cutoff },
  })),
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
// Only the two filters are stubbed (so the call args are assertable); the payload builder and the
// age/stale cutoffs stay real so these tests pin the provenance the sweep actually sends.
vi.mock('@server/worker/chunkScan', async importActual => ({
  ...(await importActual<typeof import('@server/worker/chunkScan')>()),
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date, unknown])),
  buildStrandedVectorizeScanFilter: (...a: unknown[]) => h.buildStrandedFilter(...(a as [Date, Date])),
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
      rescuedVectorizeFiles: 0,
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
      rescuedVectorizeFiles: 0,
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
    // Both rescue sweeps read FabFile.find; route the mock by which filter it was handed.
    const findResult = (docs: unknown[]) => ({ select: () => ({ limit: () => ({ lean: async () => docs }) }) });
    const routeFind = (unchunked: unknown[], stranded: unknown[]) =>
      h.fabFileFind.mockImplementation((filter: Record<string, unknown>) =>
        findResult('vectorizeEnqueueFailedAt' in filter ? stranded : unchunked)
      );

    beforeEach(() => {
      h.findStuck.mockResolvedValue([]);
      h.reconcile.mockResolvedValue([]);
      routeFind([], []);
    });

    it('re-enqueues what the filter selected, with both scan cutoffs and a convergence stamp', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      routeFind(
        [
          { _id: 'ff1', userId: 'u1' },
          { _id: 'ff2', userId: 'u2' },
        ],
        []
      );
      // No producer-side claim and no batchId: the projection reads only _id and userId now, so a
      // batch is invisible here - which is the point, both files are stamped the same way.

      const res = await handler();

      // The scan filter must receive BOTH the age cutoff AND the stale-claim cutoff; a one-arg call
      // (or the wrong Date) silently drops the stale-claim rescue arm. staleClaimBefore is the older
      // of the two (30-min stale window vs 2-min age cutoff).
      expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
      const [cutoff, staleClaimBefore] = h.buildScanFilter.mock.calls[0] as [Date, Date];
      expect(cutoff).toBeInstanceOf(Date);
      expect(staleClaimBefore).toBeInstanceOf(Date);
      expect(staleClaimBefore.getTime()).toBeLessThan(cutoff.getTime());

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

    it('projects userId as well as _id - the lean() fixtures would otherwise mask a trimmed projection', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      const selectSpy = vi.fn();
      h.fabFileFind.mockReturnValue({
        select: (projection: string) => {
          selectSpy(projection);
          return { limit: () => ({ lean: async () => [{ _id: 'ff1', userId: 'u1' }] }) };
        },
      });

      await handler();

      // Every fixture here supplies userId whatever is projected, so a trim back to '_id' alone
      // stays green while production enqueues `userId: 'undefined'`. This is the only assertion
      // that fails on that.
      expect(selectSpy).toHaveBeenCalledWith('_id userId');
    });

    it('enqueues every id the filter selected - duplicates are the worker CAS to resolve', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      routeFind(
        [
          { _id: 'ff1', userId: 'u1' },
          { _id: 'ff2', userId: 'u2' },
        ],
        []
      );

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
      routeFind(
        [
          { _id: 'ff1', userId: 'u1' },
          { _id: 'ff2', userId: 'u2' },
          { _id: 'ff3', userId: 'u3' },
          { _id: 'ff4', userId: 'u4' },
        ],
        []
      );
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
      routeFind([{ _id: 'ff1', userId: 'u1' }], []);
      h.sendToQueue.mockRejectedValue(new Error('queue unreachable'));

      const res = await handler();

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.rescuedChunkFiles).toBe(0);
      expect(body.rescueFailures).toBe(1);
    });

    it('sweeps no un-chunked files when auto-chunk is disabled', async () => {
      h.getSettingsValue.mockResolvedValue(false);
      await handler();
      expect(h.buildScanFilter).not.toHaveBeenCalled();
      expect(h.sendToQueue).not.toHaveBeenCalled();
    });

    describe('convergence-paused exclusion is resolved per run (#2120)', () => {
      // One getSettingsValue mock serves both keys, so route by name. enableAutoChunk must stay ON
      // or rescueUnchunkedFiles returns before it ever reads the pause flag, and the assertion below
      // would pass against a sweep that never ran.
      const withPauseFlag = (pauseFlag: unknown) =>
        h.getSettingsValue.mockImplementation(async (key: string) => (key === 'enableAutoChunk' ? true : pauseFlag));

      it.each([
        ['ON - paused files must not consume the rescue cap', true, true],
        ['OFF - paused files must be swept back in and rebuilt', false, false],
      ])('kill switch %s', async (_label, pauseFlag, expected) => {
        withPauseFlag(pauseFlag);

        await handler();

        // Pinned as the third ARGUMENT, not as an outcome of the filter: the filter itself is mocked
        // here, so this is the only place the caller's wiring is observable. Dropping the argument or
        // hardcoding it to a constant - the two ways this regresses - both fail one of these rows.
        expect(h.buildScanFilter).toHaveBeenCalledTimes(1);
        expect(h.buildScanFilter.mock.calls[0][2]).toEqual({ excludeConvergencePaused: expected });
      });

      it('treats a missing or non-boolean setting as OFF, never as ON', async () => {
        // The caller compares `=== true` rather than coercing, and that strictness is deliberate: a
        // truthy-but-not-true value (an unset setting, a legacy string) must fall to the sweeping
        // behaviour, because wrongly excluding is the far worse direction - it strands every paused
        // file with no automatic rebuild at all.
        for (const raw of [undefined, null, 'true', 1]) {
          h.buildScanFilter.mockClear();
          withPauseFlag(raw);

          await handler();

          expect(h.buildScanFilter.mock.calls[0][2]).toEqual({ excludeConvergencePaused: false });
        }
      });
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
      expect(body.rescuedVectorizeFiles).toBe(0);
    });

    it('re-enqueues files whose vectorize hand-off was stranded, regardless of auto-chunk', async () => {
      // Those files are already chunked, so the auto-chunk setting has no bearing on finishing
      // the hand-off - and no other sweep can see them (this one selects on the failure stamp).
      h.getSettingsValue.mockResolvedValue(false);
      routeFind([], [{ _id: 'ff9', userId: 'u9' }]);

      const res = await handler();

      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', { fabFileId: 'ff9', userId: 'u9' });
      expect(JSON.parse(res.body).rescuedVectorizeFiles).toBe(1);

      // Both cutoffs, same as the un-chunked sweep: a one-arg call drops the stale-claim arm, and a
      // file left claimed by a worker killed inside resumeVectorizeEnqueue would have no way back.
      const [cutoff, staleClaimBefore] = h.buildStrandedFilter.mock.calls[0] as [Date, Date];
      expect(cutoff).toBeInstanceOf(Date);
      expect(staleClaimBefore).toBeInstanceOf(Date);
      expect(staleClaimBefore.getTime()).toBeLessThan(cutoff.getTime());
    });

    it('a failed send costs only itself: the candidates behind it still go out', async () => {
      // A recovery sweep runs precisely when the queue is under the stress that makes a transient
      // send failure likely, so a rejection escaping the loop would abandon every file behind it and
      // report zero. The reported count is what was SENT, so a partial tick is visible in the log.
      h.getSettingsValue.mockResolvedValue(false);
      routeFind(
        [],
        [
          { _id: 'ff1', userId: 'u1' },
          { _id: 'ff2', userId: 'u2' },
          { _id: 'ff3', userId: 'u3' },
        ]
      );
      h.sendToQueue.mockRejectedValueOnce(new Error('throttled'));

      const res = await handler();

      expect(h.sendToQueue).toHaveBeenCalledTimes(3);
      expect(h.sendToQueue).toHaveBeenLastCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff3',
        userId: 'u3',
      });
      expect(JSON.parse(res.body).rescuedVectorizeFiles).toBe(2);
    });

    it('sends a stranded file UNSTAMPED, so the kill switch cannot route it into the rebuild door', async () => {
      // The inverse of the un-chunked sweep's rule (#2309), and the asymmetry is the point. These
      // files are already chunked, and the handler's halt branch sits above the already-chunked
      // resume: an `origin: convergence` stamp would make the switch write
      // `chunkStallReason: 'rechunkPaused'` over committed passages, null `chunkRebuildRequestedAt`,
      // and throw - so the resume never runs, `vectorizeEnqueueFailedAt` is never cleared, and this
      // sweep (whose filter has no paused-file exclusion) re-sends every tick until each message has
      // burned its retry ladder into the DLQ. Asserting the exact payload rather than just the
      // absence of `origin`, so re-adding the stamp cannot pass here.
      h.getSettingsValue.mockResolvedValue(false);
      routeFind([], [{ _id: 'ff9', userId: 'u9' }]);

      await handler();

      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff9',
        userId: 'u9',
      });
      expect(h.sendToQueue.mock.calls[0][1]).not.toHaveProperty('origin');
    });
  });
});
