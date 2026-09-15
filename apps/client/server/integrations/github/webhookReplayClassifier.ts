/**
 * Classifies whether a webhook delivery record can be replayed via the
 * DLQ replay endpoint (POST /api/organizations/[id]/webhooks/github/replay-dlq).
 *
 * Extracted from the endpoint so it can be unit-tested outside the
 * pages/api/ tree (Next.js builds every .ts file there as an API route,
 * which makes co-located test files invalid).
 */

export type ReplaySkipReason = 'notification_kind' | 'missing_payload' | 'missing_target_url';

/**
 * Returns the reason a delivery should be skipped during replay, or `null` if
 * the record is ready to enqueue.
 *
 *   - `'notification_kind'`  - org-webhook notification record (no outbound HTTP); not replayable here.
 *   - `'missing_payload'`    - legacy record without stored payload.
 *   - `'missing_target_url'` - legacy record with payload but no targetUrl.
 *   - `null`                 - record can be enqueued.
 */
export function classifyReplayability(delivery: {
  deliveryKind?: 'outbound_http' | 'org_notification';
  payload?: Record<string, unknown>;
  targetUrl?: string;
}): ReplaySkipReason | null {
  if (delivery.deliveryKind === 'org_notification') return 'notification_kind';
  if (!delivery.payload || Object.keys(delivery.payload).length === 0) return 'missing_payload';
  if (!delivery.targetUrl) return 'missing_target_url';
  return null;
}
