/**
 * Slack Webhook Verification Utilities
 *
 * Consolidates signature verification and replay attack prevention
 * for all Slack webhook endpoints (events, commands, interactive).
 *
 * Slack signs each request with HMAC-SHA256 using the signing secret
 * and includes X-Slack-Request-Timestamp for replay prevention.
 */
import crypto from 'crypto';

/** Replay attack tolerance window in seconds (5 minutes). */
export const SLACK_REPLAY_TOLERANCE_SECS = 300;

export type SlackVerificationFailureReason =
  | 'missing_timestamp'
  | 'missing_signature'
  | 'stale_timestamp'
  | 'invalid_signature';

/** Internal reason - MUST NOT be exposed in HTTP responses. */
export type SlackVerificationResult = { valid: true } | { valid: false; reason: SlackVerificationFailureReason };

/**
 * Check whether a Slack request timestamp is within the replay tolerance window.
 *
 * @param timestamp - Value from X-Slack-Request-Timestamp header (Unix epoch seconds)
 * @param toleranceSecs - Tolerance in seconds (default: SLACK_REPLAY_TOLERANCE_SECS)
 */
export function isSlackTimestampFresh(timestamp: string, toleranceSecs: number = SLACK_REPLAY_TOLERANCE_SECS): boolean {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const nowSecs = Math.floor(Date.now() / 1000);
  return Math.abs(nowSecs - ts) <= toleranceSecs;
}

/**
 * Combined Slack request verification: timestamp freshness + HMAC-SHA256 signature.
 *
 * Checks are ordered so that the cheapest checks (missing headers, timestamp age)
 * run before the expensive HMAC computation.
 *
 * @param body - Raw request body string
 * @param timestamp - Value from X-Slack-Request-Timestamp header
 * @param signature - Value from X-Slack-Signature header
 * @param signingSecret - Slack app signing secret
 * @param toleranceSecs - Replay tolerance in seconds (default: SLACK_REPLAY_TOLERANCE_SECS)
 */
export function verifySlackRequest(
  body: string,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
  toleranceSecs: number = SLACK_REPLAY_TOLERANCE_SECS
): SlackVerificationResult {
  if (!timestamp) {
    return { valid: false, reason: 'missing_timestamp' };
  }
  if (!signature) {
    return { valid: false, reason: 'missing_signature' };
  }
  if (!isSlackTimestampFresh(timestamp, toleranceSecs)) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const baseString = `v0:${timestamp}:${body}`;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  return isValid ? { valid: true } : { valid: false, reason: 'invalid_signature' };
}
