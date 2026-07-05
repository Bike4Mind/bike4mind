/**
 * GitHub Webhook Integration - Utilities
 *
 * Security and validation utilities for GitHub webhooks, including
 * signature verification, token generation, and payload timestamp checks.
 */

import crypto from 'crypto';
import { SignatureValidationResult } from './types';

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 *
 * GitHub sends a signature in the X-Hub-Signature-256 header in the format:
 * sha256=<hex-digest>
 *
 * We compute the expected signature using the raw request body and the webhook secret,
 * then use timing-safe comparison to prevent timing attacks.
 *
 * @param payload - Raw request body (string or Buffer)
 * @param signature - Value from X-Hub-Signature-256 header
 * @param secret - Webhook secret configured for this MCP server
 * @returns SignatureValidationResult with valid status and optional error
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string
): SignatureValidationResult {
  if (!signature) {
    return {
      valid: false,
      error: 'Missing X-Hub-Signature-256 header',
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
 * Generate a secure routing token for webhook URL identification
 *
 * This token is used in the X-Webhook-Token header to identify which
 * MCP server configuration should handle the webhook.
 *
 * @returns 64-character hex string (32 bytes of entropy)
 */
export function generateWebhookToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a secure webhook secret for HMAC signature validation
 *
 * This secret is shared between GitHub and our system to verify
 * that webhook requests actually come from GitHub.
 *
 * @returns 64-character hex string (32 bytes of entropy)
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Maximum allowed body size for webhook payloads (1MB).
 * GitHub payloads are usually small but can grow for events with many commits or large diffs.
 */
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Error thrown when request body exceeds size limit
 */
export class PayloadTooLargeError extends Error {
  constructor(size: number) {
    super(`Request body too large: ${size} bytes exceeds limit of ${MAX_BODY_SIZE} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Extract raw body from incoming request for signature verification
 *
 * Signature verification requires the exact raw body bytes that GitHub
 * used to compute the signature. This must be done before any JSON parsing.
 *
 * Includes size limit to prevent memory exhaustion from large payloads.
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

/** Replay tolerance for GitHub payload-based timestamp checks (5 minutes). */
export const GITHUB_REPLAY_TOLERANCE_SECS = 300;

export interface GitHubTimestampCheckResult {
  fresh: boolean;
  /** Which payload field the timestamp was extracted from, if any. */
  timestampSource?: string;
}

/**
 * Best-effort payload timestamp validation for GitHub webhooks.
 *
 * GitHub does NOT send a timestamp header (X-GitHub-Delivery is a UUID).
 * This checks common timestamp fields in the parsed payload for events
 * like push (head_commit.timestamp) and pull_request/issues (updated_at).
 *
 * Returns { fresh: true } if no timestamp is found - we cannot reject
 * what we cannot verify. This is advisory only (log, don't reject).
 */
export function verifyGitHubPayloadTimestamp(
  payload: Record<string, unknown>,
  toleranceSecs: number = GITHUB_REPLAY_TOLERANCE_SECS
): GitHubTimestampCheckResult {
  const nowMs = Date.now();
  const toleranceMs = toleranceSecs * 1000;

  // Push events: head_commit.timestamp (ISO 8601)
  const headCommit = payload.head_commit as Record<string, unknown> | undefined;
  if (headCommit?.timestamp && typeof headCommit.timestamp === 'string') {
    const ts = Date.parse(headCommit.timestamp);
    if (!isNaN(ts)) {
      return { fresh: Math.abs(nowMs - ts) <= toleranceMs, timestampSource: 'head_commit.timestamp' };
    }
  }

  // PR / issue / release events: updated_at on the primary object
  for (const key of ['pull_request', 'issue', 'release', 'discussion']) {
    const obj = payload[key] as Record<string, unknown> | undefined;
    if (obj?.updated_at && typeof obj.updated_at === 'string') {
      const ts = Date.parse(obj.updated_at);
      if (!isNaN(ts)) {
        return { fresh: Math.abs(nowMs - ts) <= toleranceMs, timestampSource: `${key}.updated_at` };
      }
    }
  }

  // No verifiable timestamp found - pass through
  return { fresh: true };
}
