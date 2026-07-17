import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { CreateBatchRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { recordReconcilerForcedTerminal } from '@server/utils/cloudwatch';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET: list user's active batches (reconciles stuck ones at read time first)
  .get(async (req: Request, res) => {
    const userId = req.user.id;
    const active = await dataLakeBatchRepository.findActiveByUserId(userId);

    // Read-time reconciliation: force non-terminal batches idle past the timeout to a
    // terminal state (guarded), and recompute lake stats from source. No watchdog cron.
    await dataLakeService.reconcileStuckBatches(active, dataLakeService.DEFAULT_STUCK_BATCH_TIMEOUT_MS, {
      db: { dataLakes: dataLakeRepository, batches: dataLakeBatchRepository, fabFiles: fabFileRepository },
      logger: console,
      // Forced-terminal is rare, so the awaited emit only costs latency on the exceptional path; the
      // stuck gauge is deliberately omitted here (it belongs on the cron's fixed cadence, not per read).
      metrics: { emitForcedTerminal: () => recordReconcilerForcedTerminal().catch(() => {}) },
    });

    const batches = await dataLakeBatchRepository.findActiveByUserId(userId);
    return res.json({ data: batches });
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
