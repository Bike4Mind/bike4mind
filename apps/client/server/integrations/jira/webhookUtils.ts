/**
 * Jira Webhook Integration - Utilities
 *
 * Security utilities for Jira webhook signature validation and token generation.
 *
 * Jira Cloud webhook signature uses HMAC-SHA256, sent in X-Hub-Signature header.
 * Format: sha256=<hex-digest>
 */

import crypto from 'crypto';

/**
 * Signature validation result.
 */
export interface SignatureValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify Jira webhook signature using HMAC-SHA256.
 *
 * Jira sends a signature in the X-Hub-Signature header in the format:
 * sha256=<hex-digest>
 *
 * We compute the expected signature using the raw request body and the webhook secret,
 * then use timing-safe comparison to prevent timing attacks.
 *
 * @param payload - Raw request body (string or Buffer)
 * @param signature - Value from X-Hub-Signature header
 * @param secret - Webhook secret configured for this webhook
 * @returns SignatureValidationResult with valid status and optional error
 */
export function verifyJiraSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string
): SignatureValidationResult {
  if (!signature) {
    return {
      valid: false,
      error: 'Missing X-Hub-Signature header',
    };
  }

  if (!signature.startsWith('sha256=')) {
    return {
      valid: false,
      error: 'Invalid signature format - expected sha256=<hex>',
    };
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    // Buffers must be same length for timingSafeEqual
    if (signatureBuffer.length !== expectedBuffer.length) {
      return {
        valid: false,
        error: 'Signature length mismatch',
      };
    }

    const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    return {
      valid: isValid,
      error: isValid ? undefined : 'Signature verification failed',
    };
  } catch {
    return {
      valid: false,
      error: 'Signature comparison failed',
    };
  }
}

/**
 * Generate a secure routing token for webhook URL identification.
 *
 * This token is used in the URL path to identify which webhook configuration
 * should handle the event.
 *
 * @returns 64-character hex string (32 bytes of entropy)
 */
export function generateRoutingToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a secure webhook secret for HMAC signature validation.
 *
 * This secret is shared between Jira and our system to verify
 * that webhook requests actually come from Jira.
 *
 * @returns 64-character hex string (32 bytes of entropy)
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Rotation window duration (24 hours).
 * During this window, both the current and previous secrets are accepted.
 * This gives the admin time to update the secret in Jira Admin -> System -> Webhooks.
 */
export const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Maximum allowed body size for webhook payloads (1MB).
 */
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Error thrown when request body exceeds size limit.
 */
export class PayloadTooLargeError extends Error {
  constructor(size: number) {
    super(`Request body too large: ${size} bytes exceeds limit of ${MAX_BODY_SIZE} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Extract raw body from incoming request for signature verification.
 *
 * Signature verification requires the exact raw body bytes that Jira
 * used to compute the signature. This must be done before any JSON parsing.
 *
 * @param req - Node.js HTTP IncomingMessage
 * @param maxSize - Maximum body size in bytes (default: 1MB)
 * @returns Promise<Buffer> - Raw request body
 * @throws PayloadTooLargeError if body exceeds size limit
 */
export async function getRawBody(
  req: {
    on: (event: 'data' | 'end' | 'error', callback: (data?: Buffer | Error) => void) => void;
  },
  maxSize: number = MAX_BODY_SIZE
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', chunk => {
      if (chunk) {
        totalSize += (chunk as Buffer).length;
        if (totalSize > maxSize) {
          reject(new PayloadTooLargeError(totalSize));
          return;
        }
        chunks.push(chunk as Buffer);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

/**
 * Jira webhook event types we support.
 */
export const SUPPORTED_JIRA_EVENTS = new Set([
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'comment_updated',
  'comment_deleted',
  'sprint_created',
  'sprint_updated',
  'sprint_started',
  'sprint_closed',
  'sprint_deleted',
]);

/**
 * Check if an event type is supported.
 */
export function isSupportedJiraEvent(eventType: string): boolean {
  return SUPPORTED_JIRA_EVENTS.has(eventType);
}

/** Replay tolerance for Jira payload timestamp checks (5 minutes in ms). */
export const JIRA_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

/** Internal reason - MUST NOT be exposed in HTTP responses. */
export type JiraTimestampValidationResult =
  | { valid: true }
  | { valid: false; reason: 'invalid_timestamp' | 'timestamp_expired' };

/**
 * Validate the `timestamp` field from a parsed Jira webhook payload.
 *
 * Jira Cloud sends a `timestamp` field as Unix epoch milliseconds.
 * This is defense-in-depth - must only be called AFTER signature verification.
 *
 * @param payloadTimestamp - The `timestamp` field from the Jira payload
 * @param nowMs - Current time in ms (injectable for testing)
 */
export function validateJiraPayloadTimestamp(
  payloadTimestamp: unknown,
  nowMs: number = Date.now()
): JiraTimestampValidationResult {
  if (payloadTimestamp === undefined || payloadTimestamp === null) {
    return { valid: true };
  }

  const ts = typeof payloadTimestamp === 'number' ? payloadTimestamp : parseInt(String(payloadTimestamp), 10);

  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  if (Math.abs(nowMs - ts) > JIRA_REPLAY_TOLERANCE_MS) {
    return { valid: false, reason: 'timestamp_expired' };
  }

  return { valid: true };
}
