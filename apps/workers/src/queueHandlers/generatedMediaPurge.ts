import { Session } from '@bike4mind/database';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import {
  MAX_PURGE_KEYS,
  MAX_PURGE_SESSION_IDS,
  enqueueGeneratedMediaPurge,
} from '@server/sessions/generatedMediaPurgeQueue';
import { runGeneratedMediaPurge } from '@server/sessions/purgeDeletedNotebookMedia';
import { z, ZodError } from 'zod';

// Under the 5-minute Lambda timeout (infra/queues.ts), leaving room for the CDN flush.
export const WORKER_PURGE_BUDGET_MS = 4 * 60 * 1000;

const Payload = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sessions'),
    sessionIds: z
      .array(z.string().regex(/^[a-f0-9]{24}$/i))
      .min(1)
      .max(MAX_PURGE_SESSION_IDS),
  }),
  z.object({ kind: z.literal('keys'), keys: z.array(z.string().min(1)).min(1).max(MAX_PURGE_KEYS) }),
]);

/**
 * Finishes a generated media purge a notebook delete handed off (producer:
 * apps/client/server/sessions/generatedMediaPurgeQueue.ts). Only notebooks that are soft-deleted are
 * looked up; a live id is dropped. What this run does not reach is re-enqueued when it made progress;
 * otherwise, and when storage or the re-enqueue fails, it throws so SQS retries and then dead-letters it.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const record = event.Records[0];
  if (!record) {
    logger.warn('Skipping generated-media-purge event with no records');
    return;
  }
  let payload: z.infer<typeof Payload>;
  try {
    payload = Payload.parse(JSON.parse(record.body));
  } catch (err) {
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`[NOTEBOOK_MEDIA] Dropping malformed generated media purge message: ${err.message}`);
      return;
    }
    throw err;
  }

  let input: { sessionIds?: string[]; keys?: string[] };
  let deletedSessionIds = new Set<string>();
  if (payload.kind === 'sessions') {
    const deleted = await Session.find({ _id: { $in: payload.sessionIds }, deletedAt: { $ne: null } }, { _id: 1 })
      .setOptions({ includeDeleted: true })
      .lean();
    deletedSessionIds = new Set(deleted.map(s => String(s._id)));
    const skipped = payload.sessionIds.length - deletedSessionIds.size;
    if (skipped > 0) logger.warn(`[NOTEBOOK_MEDIA] Skipping ${skipped} notebooks that are not deleted`);
    if (deletedSessionIds.size === 0) return;
    input = { sessionIds: [...deletedSessionIds] };
  } else {
    input = { keys: payload.keys };
  }

  const { leftoverSessionIds, leftoverKeys } = await runGeneratedMediaPurge(input, {
    deadline: Date.now() + WORKER_PURGE_BUDGET_MS,
    deletedSessionIds,
    logger,
  });
  const left = leftoverSessionIds.length + leftoverKeys.length;
  if (left === 0) return;
  // Progress is measured in the unit the message carried: resolved notebooks, or deleted keys.
  const progressed =
    payload.kind === 'sessions'
      ? leftoverSessionIds.length < deletedSessionIds.size
      : leftoverKeys.length < payload.keys.length;
  if (!progressed) throw new Error(`generated media purge made no progress on ${left} items`);
  const sent = await enqueueGeneratedMediaPurge({ sessionIds: leftoverSessionIds, keys: leftoverKeys }, logger);
  if (!sent) throw new Error(`could not re-enqueue ${left} generated media purge items`);
});
