import { recomputeStatsForLakeTags } from './recomputeStatsForLakeTags';

/** The file fields this needs; a lean projection or a hydrated document both satisfy it. */
type UploadedFile = { batchId?: string | null; tags?: ({ name?: string | null } | null)[] | null };

/**
 * Rebuild the stats of every lake a freshly-uploaded file joined, at the one moment its bytes are
 * known to be in storage.
 *
 * The upload doors stamp a lake's meta-tag when they CREATE the row, before the browser has sent
 * anything, so counting there would count a file that may never arrive. That matters more than a
 * wrong number: `recomputeLakeStats` also performs the one-way draft -> active transition, so a
 * count taken too early can park an empty lake in Discover permanently, with nothing to undo it.
 *
 * Call from every site that marks a FabFile 'complete': the hosted S3 event
 * (`server/s3/objectCreated.ts`), the self-host MinIO webhook
 * (`pages/api/internal/s3/object-created.ts`) and the self-host upload proxy
 * (`pages/api/files/[id]/upload.ts`). The last two both fire for one object on self-host - the
 * second recompute is an idempotent no-op, exactly like their duplicate status write.
 *
 * Batch files are skipped: the batch finalizer recomputes the lake ONCE for the whole batch, so
 * doing it per file would run N identical aggregations for an N-file upload.
 */
export const recomputeStatsForUploadedFile = async (
  file: UploadedFile,
  { logger }: { logger: { error: (msg: string, meta?: Record<string, unknown>) => void } }
): Promise<void> => {
  if (file.batchId) return;

  await recomputeStatsForLakeTags(
    (file.tags ?? []).map(tag => tag?.name),
    { logger }
  );
};
