import crypto from 'crypto';

/**
 * The outbound signed-webhook wire format, shared by every handler that POSTs to a
 * caller-owned endpoint (apps/workers/src/queueHandlers/webhookDelivery.ts,
 * queueHandlers/generationCallback.ts)
 * so receivers verify all of them the same way. Changing a header name or the signed-string
 * layout breaks every integration already verifying it.
 */

/** Per-attempt HTTP timeout, in ms. */
export const WEBHOOK_HTTP_TIMEOUT_MS = 10_000;

/** Receiver responses that retrying cannot fix. */
export const PERMANENT_FAILURE_CODES: readonly number[] = [400, 401, 403, 404, 410];

const WEBHOOK_USER_AGENT = 'Lumina5-Webhook/1.0';

/** Thrown to hand a delivery back to SQS for redelivery (then the DLQ). */
export class RetryableError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export type SignedWebhookInput = {
  secret: string;
  /** The exact bytes sent; the signature covers this string, not a re-serialization of it. */
  body: string;
  /** Stable across retries, so the receiver can dedupe. */
  eventId: string;
  /** Unique per attempt. */
  deliveryId: string;
  eventType: string;
  timestampSeconds?: number;
};

/**
 * `X-Webhook-Signature-256: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`. The timestamp is
 * inside the signed string so a receiver can reject replays outside its tolerance window.
 */
export function buildSignedWebhookHeaders(input: SignedWebhookInput): Record<string, string> {
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-Webhook-Event-ID': input.eventId,
    'X-Webhook-Delivery-ID': input.deliveryId,
    'X-Webhook-Timestamp': String(timestamp),
    'X-Webhook-Signature-256': `sha256=${signature}`,
    'X-Event-Type': input.eventType,
    'User-Agent': WEBHOOK_USER_AGENT,
  };
}
