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
  runSweep: vi.fn(async () => ({ enqueued: 0, failed: 0 })),
  buildScanFilter: vi.fn((cutoff: Date, _staleClaimBefore?: Date, _opts?: unknown) => ({
    chunkCount: 0,
    createdAt: { $lt: cutoff },
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
vi.mock('@server/worker/chunkRescueSweep', () => ({
  runChunkRescueSweep: (...a: unknown[]) => h.runSweep(...(a as [])),
}));
vi.mock('@server/worker/chunkScan', () => ({
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date, unknown])),
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
    // The sweep itself lives in server/worker/chunkRescueSweep.ts and is covered there, by the same
    // suite that covers the self-host driver - that shared function is why the two can no longer
    // drift. What is the CRON's own business, and all this block asserts, is that it calls the sweep
    // with the hosted budget, folds both counts into its response, and isolates a failure.
    beforeEach(() => {
      h.findStuck.mockResolvedValue([]);
      h.reconcile.mockResolvedValue([]);
      h.runSweep.mockResolvedValue({ enqueued: 0, failed: 0 });
    });

    it('calls the shared sweep with the hosted per-run budget', async () => {
      // 500/day here vs 50/tick on self-host: the one thing the two drivers differ on, so passing the
      // wrong one (or letting the sweep hardcode it) is the regression worth pinning.
      await handler();

      expect(h.runSweep).toHaveBeenCalledTimes(1);
      expect(h.runSweep.mock.calls[0][0]).toEqual(expect.objectContaining({ limit: 500 }));
    });

    it('folds BOTH counts into the response body', async () => {
      // `failed` is not decoration: a tick where every send failed used to report as an idle install.
      h.runSweep.mockResolvedValue({ enqueued: 2, failed: 3 });

      const body = JSON.parse((await handler()).body);

      expect(body.rescuedChunkFiles).toBe(2);
      expect(body.rescueFailures).toBe(3);
    });

    it('a rescue failure is isolated: the run still heartbeats and reports zero', async () => {
      h.runSweep.mockRejectedValue(new Error('mongo down'));

      const body = JSON.parse((await handler()).body);

      expect(body.rescuedChunkFiles).toBe(0);
      expect(body.rescueFailures).toBe(0);
      expect(h.recordRun).toHaveBeenCalled();
    });
  });
});
