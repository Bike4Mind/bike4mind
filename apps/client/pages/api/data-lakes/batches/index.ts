import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { CreateBatchRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { recordReconcilerForcedTerminal } from '@server/utils/cloudwatch';
import { enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET: list batches the user still needs to see - either ingest is in flight, or the
  // background AI-tagging phase is running/awaiting review. These are independent
  // clocks: a batch can be fully 'completed' (ingest) while 'analyzing' (taxonomy), so they
  // are fetched, reconciled, and re-fetched as two separate sets, then merged for the caller.
  .get(async (req: Request, res) => {
    const userId = req.user.id;
    const [ingestActive, taxonomyActive] = await Promise.all([
      dataLakeBatchRepository.findActiveByUserId(userId),
      dataLakeBatchRepository.findActiveTaxonomyByUserId(userId),
    ]);

    // Read-time reconciliation: force non-terminal batches idle past the timeout to a
    // terminal state (guarded), and recompute lake stats from source. The daily
    // dataLakeBatchReconcile cron is the fallback for batches nobody ever opens the list for.
    await dataLakeService.reconcileStuckBatches(ingestActive, dataLakeService.DEFAULT_STUCK_BATCH_TIMEOUT_MS, {
      db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
      logger: console,
      // Forced-terminal is rare, so the awaited emit only costs latency on the exceptional path; the
      // stuck gauge is deliberately omitted here (it belongs on the cron's fixed cadence, not per read).
      // Also backstops the taxonomy enqueue for a batch that never reached upload-complete NOR
      // a terminal chunk/vectorize event (finalizeBatchIfComplete already backstops the latter
      // case) - this is the last resort for a batch that is genuinely stuck, not just one whose
      // upload-complete request happened to fail.
      metrics: {
        emitForcedTerminal: batch =>
          Promise.all([
            recordReconcilerForcedTerminal().catch(() => {}),
            enqueueTaxonomyAnalysisIfWanted(batch, console).catch(() => {}),
          ]).then(() => {}),
      },
    });
    // taxonomyActive is the non-terminal working set only (not the capped/sorted list-response
    // set - see findActiveTaxonomyByUserId), so a batch stuck for hours is never excluded here
    // just because it's not among the user's most-recently-updated attention batches.
    await dataLakeService.reconcileStuckTaxonomy(taxonomyActive, dataLakeService.DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS, {
      db: { batches: dataLakeBatchRepository },
      logger: console,
    });

    const [freshIngestActive, freshTaxonomyAttention] = await Promise.all([
      dataLakeBatchRepository.findActiveByUserId(userId),
      dataLakeBatchRepository.findTaxonomyAttentionByUserId(userId),
    ]);
    const byId = new Map([...freshIngestActive, ...freshTaxonomyAttention].map(b => [b.id, b]));
    return res.json({ data: Array.from(byId.values()) });
  })
  // POST: create a new batch
  .post(async (req: Request, res) => {
    const userId = req.user.id;
    const data = CreateBatchRequestInput.parse(req.body);

    // Creating a batch flips a draft lake to active and opens it for uploads - a WRITE. Gate it
    // with the creator/admin check (not just read access) so a read-only member can't inject
    // files into a lake they don't own. Not-found-style denial when the lake isn't even
    // readable; manage-denied when readable but not owned.
    const dataLake = await dataLakeService.assertLakeWriteAccess(data.dataLakeId, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository },
    });

    // Don't accept new uploads into an archived/deleted (or transitional) lake - only
    // draft (first batch) or active lakes can receive a batch.
    if (dataLake.status !== 'draft' && dataLake.status !== 'active') {
      return res.status(400).json({ error: `Cannot create a batch for a data lake in '${dataLake.status}' status` });
    }

    const batch = await dataLakeBatchRepository.create({
      dataLakeId: dataLake.id,
      userId,
      status: 'preparing',
      conflictResolution: data.conflictResolution ?? 'skip',
      totalFiles: data.totalFiles,
      totalSizeBytes: data.totalSizeBytes,
      uploadedFiles: 0,
      chunkedFiles: 0,
      vectorizedFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,
      uploadedSizeBytes: 0,
      files: [],
      appliedTags: data.appliedTags || [],
      startedAt: new Date(),
      wantsTaxonomy: data.wantsTaxonomy ?? false,
      taxonomyStatus: 'none',
    });

    // Creating the first batch flips a draft lake to active (one-way).
    if (dataLake.status === 'draft') {
      await dataLakeRepository.update({ id: dataLake.id, status: 'active' });
    }

    return res.json(batch);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
