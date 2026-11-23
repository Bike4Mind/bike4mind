import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC over a quest dispatch, sent by dispatchQuest.ts and checked by the ChatCompletion
 * `/process` route (chatCompletion/internal/route.ts) after its bearer check.
 */
export const QUEST_DISPATCH_SIGNATURE_HEADER = 'x-b4m-dispatch-signature';
export const QUEST_DISPATCH_TIMESTAMP_HEADER = 'x-b4m-dispatch-timestamp';
/** Accepted distance between the signing time and receipt, either direction (ms). */
export const QUEST_DISPATCH_MAX_SKEW_MS = 5 * 60_000;

const KEY_CONTEXT = 'quest-dispatch-v1';
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{1,16}$/;

export interface QuestDispatchIdentity {
  questId: string;
  userId: string;
  sessionId: string;
}

export interface QuestDispatchSignature {
  timestamp: string;
  signature: string;
}

function computeSignature(
  secret: string,
  identity: QuestDispatchIdentity,
  body: string | Buffer,
  timestamp: string
): Buffer {
  const key = createHmac('sha256', secret).update(KEY_CONTEXT).digest();
  const bodyDigest = createHash('sha256').update(body).digest('hex');
  const canonical = [KEY_CONTEXT, timestamp, identity.questId, identity.userId, identity.sessionId, bodyDigest].join(
    '\n'
  );
  return createHmac('sha256', key).update(canonical).digest();
}

/** `body` must be the exact bytes sent on the wire. */
export function signQuestDispatch(
  secret: string,
  identity: QuestDispatchIdentity,
  body: string | Buffer,
  nowMs: number = Date.now()
): QuestDispatchSignature {
  const timestamp = String(nowMs);
  return { timestamp, signature: computeSignature(secret, identity, body, timestamp).toString('hex') };
}

export function verifyQuestDispatch(
  secret: string,
  identity: QuestDispatchIdentity,
  body: string | Buffer,
  provided: { timestamp: unknown; signature: unknown },
  nowMs: number = Date.now()
): boolean {
  const { timestamp, signature } = provided;
  if (typeof timestamp !== 'string' || !TIMESTAMP_PATTERN.test(timestamp)) return false;
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) return false;
  if (Math.abs(nowMs - Number(timestamp)) > QUEST_DISPATCH_MAX_SKEW_MS) return false;
  const expected = computeSignature(secret, identity, body, timestamp);
  return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}
