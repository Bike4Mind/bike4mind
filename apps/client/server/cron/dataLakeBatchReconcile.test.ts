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
  const mockLogger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };
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
vi.mock('@server/worker/chunkScan', () => ({
  buildFabFileChunkScanFilter: (...a: unknown[]) => h.buildScanFilter(...(a as [Date, Date])),
  buildStrandedVectorizeScanFilter: (cutoff: Date) => ({ vectorizeEnqueueFailedAt: { $lt: cutoff } }),
  CHUNK_SCAN_MIN_AGE_MS: 2 * 60_000,
  CHUNK_CLAIM_STALE_MS: 30 * 60_000,
  VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS: 15 * 60_000,
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
    // Rescue sweep defaults: auto-chunk off, no candidates.
    h.getSettingsValue.mockResolvedValue(false);
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

    it('CLAIMS then re-enqueues only the ids it won, tagging each with its claim token', async () => {
      h.getSettingsValue.mockResolvedValue(true);
      routeFind(
        [
          { _id: 'ff1', userId: 'u1' }, // plain upload, no lake batch
          { _id: 'ff2', userId: 'u2', batchId: 'batch-9' }, // data-lake file
        ],
        []
      );
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
      // A plain lost-webhook upload (no batch) is user work - it must always run, so no origin (#1676).
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff1',
        userId: 'u1',
      });
      // A data-lake file (has a batch) is convergence work, haltable by the kill switch; a global
      // sweep carries no lakeId (platform switch only).
      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff2',
        userId: 'u2',
        origin: 'convergence',
      });
      expect(JSON.parse(res.body).rescuedChunkFiles).toBe(2);
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
      });
      expect(JSON.parse(res.body).rescuedChunkFiles).toBe(2);
    });

    it('sweeps no un-chunked files when auto-chunk is disabled', async () => {
      h.getSettingsValue.mockResolvedValue(false);
      await handler();
      expect(h.buildScanFilter).not.toHaveBeenCalled();
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
      expect(JSON.parse(res.body).rescuedChunkFiles).toBe(0);
      expect(JSON.parse(res.body).rescuedVectorizeFiles).toBe(0);
    });

    it('re-enqueues files whose vectorize hand-off was stranded, regardless of auto-chunk', async () => {
      // Those files are already chunked, so the auto-chunk setting has no bearing on finishing
      // the hand-off - and no other sweep can see them (this one selects on the failure stamp).
      h.getSettingsValue.mockResolvedValue(false);
      routeFind([], [{ _id: 'ff9', userId: 'u9' }]);

      const res = await handler();

      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', { fabFileId: 'ff9', userId: 'u9' });
      expect(JSON.parse(res.body).rescuedVectorizeFiles).toBe(1);
    });

    it('tags a stranded lake file as convergence work so the kill switch can halt it', async () => {
      h.getSettingsValue.mockResolvedValue(false);
      routeFind([], [{ _id: 'ff9', userId: 'u9', batchId: 'batch-9' }]);

      await handler();

      expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
        fabFileId: 'ff9',
        userId: 'u9',
        origin: 'convergence',
      });
    });
  });
});
