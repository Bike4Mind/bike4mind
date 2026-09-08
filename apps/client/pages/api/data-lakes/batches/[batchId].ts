import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { BATCH_TERMINAL_STATUSES, type BatchStatus } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';

const UpdateBatchInput = z.object({
  status: z.enum(['preparing', 'uploading', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled']),
  failedFiles: z.number().nonnegative().optional(),
  failedFileNames: z.array(z.string()).optional(),
});

/**
 * Rebuild the lake's stats once a batch stops here rather than at the finalizer. A batch the
 * client fails or cancels after some files already landed never reaches
 * `finalizeBatchIfComplete`, and the stuck-batch reconciler skips terminal batches. Nothing on
 * the batch's own path is left to count what did arrive, so until some unrelated door touches
 * the lake its counts are wrong and, if it is still a draft, it stays invisible.
 *
 * Best-effort: the batch transition has already committed, so a failure here is stale stats, not
 * a failed request.
 */
const recomputeLakeAfterTerminal = async (
  status: BatchStatus,
  dataLakeId: string,
  // `warn` too, not just `error`: the audit write inside recomputeLakeStats is best-effort and
  // reports failures via `warn`. Unthreaded it falls back to `console.warn`, where log-based
  // alerting cannot see an audit trail going dark.
  logger: { warn: (msg: string, ...args: unknown[]) => void; error: (msg: string) => void },
  // Both verbs on this route are authenticated, so a draft -> active flip they cause is a USER's
  // doing and should say so. Without this it records `system`, which is what the unattributed
  // queue-side finalizer legitimately records - and conflating the two would make an operator
  // action indistinguishable from a background one. The rung stays `system` regardless, because
  // activateIfDraft authorizes nothing.
  actor?: { userId: string; isAdmin: boolean }
): Promise<void> => {
  if (!BATCH_TERMINAL_STATUSES.includes(status)) return;

  try {
    const lake = await dataLakeRepository.findById(dataLakeId);
    if (!lake) return;
    await dataLakeService.recomputeLakeStats(
      lake,
      { db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository, ...lakeConfigAuditDb }, logger },
      actor ? { actor } : undefined
    );
  } catch (error) {
    logger.error(`Error recomputing data lake stats for terminal batch in lake ${dataLakeId}: ${error}`);
  }
};

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET: batch status
  .get(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    return res.json(batch);
  })
  // PUT: update batch status
  .put(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const data = UpdateBatchInput.parse(req.body);

    // Guarded, like every other status write on this collection (markTerminalIfActive in the DELETE
    // below, setStatusIfActive in upload-complete, setTaxonomyStatusIfActive in the taxonomy job).
    // A plain update here could write a batch the queue finalizer had already settled back to a
    // non-terminal status: it would reappear in findActiveByUserId and reconcileStuckBatches would
    // later force-fail a batch that actually succeeded. The ownership check above still runs first,
    // so this only ever narrows what an authorized caller may do.
    const updated = await dataLakeBatchRepository.updateIfActive(batchId, {
      status: data.status,
      ...(data.failedFiles !== undefined && { failedFiles: data.failedFiles }),
      ...(data.failedFileNames !== undefined && { failedFileNames: data.failedFileNames }),
      ...((data.status === 'completed' || data.status === 'completed_with_errors') && { completedAt: new Date() }),
    });

    // Only on the transition INTO terminal, and now decided by the CLAIM rather than by the status
    // read above - a finalization landing between that read and this write used to be both
    // overwritten and mis-classified here, triggering a second whole-lake aggregation. Losing is a
    // benign no-op (the batch is already settled, so the caller's intent is moot), matching how
    // upload-complete treats a lost setStatusIfActive.
    if (updated) {
      await recomputeLakeAfterTerminal(data.status, batch.dataLakeId, req.logger, {
        userId: req.user.id,
        isAdmin: !!req.user.isAdmin,
      });
    }

    return res.json({ success: true });
  })
  // DELETE: cancel batch
  .delete(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId } = req.query as { batchId: string };

    const batch = await dataLakeBatchRepository.findById(batchId);
    if (!batch || batch.userId !== userId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Guarded cancel: only transitions a still-non-terminal batch, so it can't race
    // a concurrent finalization.
    const cancelled = await dataLakeBatchRepository.markTerminalIfActive(batchId, 'cancelled');
    if (!cancelled) {
      return res.status(400).json({ error: `Batch is already ${batch.status}` });
    }

    await recomputeLakeAfterTerminal('cancelled', batch.dataLakeId, req.logger, {
      userId: req.user.id,
      isAdmin: !!req.user.isAdmin,
    });

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
