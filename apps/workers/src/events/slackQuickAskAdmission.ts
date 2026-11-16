import { createHash } from 'node:crypto';
import type { ICacheRepository } from '@bike4mind/common';
import { z } from 'zod';

export const QUICK_ASK_MAX_EVENT_AGE_MS = 30 * 60 * 60 * 1_000;
export const QUICK_ASK_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const RequestIdentitySchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200).optional(),
    requestedAt: z.iso.datetime().optional(),
  })
  .refine(value => (value.requestId === undefined) === (value.requestedAt === undefined), {
    message: 'Quick Ask request identity and time must be provided together',
  });
const EnvelopeIdentitySchema = z.object({ id: z.string().min(1).max(200), time: z.iso.datetime() });

type RequestIdentity = z.infer<typeof RequestIdentitySchema>;

/** At-most-once admission, not recovery: retain the claim after any partial Slack or paid work. */
export async function claimQuickAskDelivery(
  detail: RequestIdentity,
  envelope: { id?: unknown; time?: unknown },
  cache: Pick<ICacheRepository, 'incrementCounterConditional'>,
  now = new Date()
): Promise<boolean> {
  const request = RequestIdentitySchema.parse(detail);
  const identity =
    request.requestId && request.requestedAt
      ? { kind: 'request', id: request.requestId, time: request.requestedAt }
      : { kind: 'event', ...EnvelopeIdentitySchema.parse(envelope) };
  const ageMs = now.getTime() - new Date(identity.time).getTime();
  if (!Number.isFinite(ageMs) || ageMs > QUICK_ASK_MAX_EVENT_AGE_MS || ageMs < -MAX_FUTURE_SKEW_MS) {
    throw new Error('Quick Ask event is outside its admission window');
  }
  // No question, token or user payload is persisted in the claim.
  const digest = createHash('sha256')
    .update(JSON.stringify([request.workspaceId, identity.kind, identity.id]))
    .digest('hex');
  const result = await cache.incrementCounterConditional(
    `slack-quick-ask:admission:${digest}`,
    1,
    QUICK_ASK_CLAIM_TTL_MS
  );
  return result.success;
}
