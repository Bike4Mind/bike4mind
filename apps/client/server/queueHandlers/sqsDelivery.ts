import type { SQSEvent } from 'aws-lambda';

// Kept separate per queue (rather than one shared constant) because infra already lets queues
// diverge - see infra/queues.ts's dlq.retry, which is 2 for dataLakeTaxonomyQueue and 3 for both
// of these - so a future change to one queue's retry count can't silently mis-gate the other.
// Also mirrored by the self-host worker's default maxReceiveCount (3) for these queues
// (apps/client/server/worker/selfHostWorker.ts) - keep all three in sync.
export const FAB_FILE_CHUNK_MAX_RECEIVE_COUNT = 3; // mirrors fabFileChunkQueue.dlq.retry
export const FAB_FILE_VECTORIZE_MAX_RECEIVE_COUNT = 3; // mirrors fabFileVectorizeQueue.dlq.retry

/**
 * Delivery number of this SQS message (1-based). Both queues these helpers serve are pinned to
 * `batch: { size: 1 }` (infra/queues.ts), so `event.Records[0]` is always the whole message.
 * `undefined` when the attribute is absent or not a positive integer (a hand-built test event,
 * or `Number('1.5')`/`Number('')`-style malformed input).
 */
export function getDeliveryAttempt(event: SQSEvent): number | undefined {
  const raw: string | undefined = event.Records?.[0]?.attributes?.ApproximateReceiveCount;
  const attempt = Number(raw);
  return Number.isInteger(attempt) && attempt >= 1 ? attempt : undefined;
}

/**
 * True once this delivery is the last SQS will make before routing the message to the DLQ.
 * An unknown attempt count (missing attribute, or a malformed/hand-built event) is treated as
 * final: this preserves today's behavior wherever the attribute isn't set, and fails toward a
 * batch reaching a terminal state rather than one that hangs forever. `>=` rather than `===` so
 * a manually redriven message (its receive count can already be at or past `maxReceiveCount`)
 * still reads as final - a lower count on a later delivery is also safe: every write this gates
 * is idempotent/guarded, so it can be evaluated repeatedly without double-accounting.
 */
export function isFinalDeliveryAttempt(event: SQSEvent, maxReceiveCount: number): boolean {
  const attempt = getDeliveryAttempt(event);
  return attempt === undefined || attempt >= maxReceiveCount;
}
