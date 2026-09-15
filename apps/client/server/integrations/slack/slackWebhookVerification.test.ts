import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { verifySlackRequest, isSlackTimestampFresh, SLACK_REPLAY_TOLERANCE_SECS } from './slackWebhookVerification';

/** Helper: compute a valid Slack signature for the given body + timestamp + secret. */
function computeSlackSignature(body: string, timestamp: string, secret: string): string {
  return `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

describe('isSlackTimestampFresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for a timestamp within the tolerance window', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    expect(isSlackTimestampFresh(String(nowSecs))).toBe(true);
  });

  it('returns true for a timestamp exactly at the tolerance boundary', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const boundary = nowSecs - SLACK_REPLAY_TOLERANCE_SECS;
    expect(isSlackTimestampFresh(String(boundary))).toBe(true);
  });

  it('returns false for a timestamp 1 second past the tolerance', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const expired = nowSecs - SLACK_REPLAY_TOLERANCE_SECS - 1;
    expect(isSlackTimestampFresh(String(expired))).toBe(false);
  });

  it('returns true for a future timestamp within tolerance', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const future = nowSecs + 60; // 1 minute in the future
    expect(isSlackTimestampFresh(String(future))).toBe(true);
  });

  it('returns false for a future timestamp beyond tolerance', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const farFuture = nowSecs + SLACK_REPLAY_TOLERANCE_SECS + 1;
    expect(isSlackTimestampFresh(String(farFuture))).toBe(false);
  });

  it('returns false for non-numeric timestamp', () => {
    expect(isSlackTimestampFresh('not-a-number')).toBe(false);
  });

  it('respects custom tolerance parameter', () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const ts = nowSecs - 10; // 10 seconds ago
    expect(isSlackTimestampFresh(String(ts), 5)).toBe(false); // 5s tolerance
    expect(isSlackTimestampFresh(String(ts), 15)).toBe(true); // 15s tolerance
  });
});

describe('verifySlackRequest', () => {
  const secret = 'test-signing-secret';
  const body = 'token=abc&team_id=T123';

  function makeTimestamp(offsetSecs = 0): string {
    return String(Math.floor(Date.now() / 1000) + offsetSecs);
  }

  it('returns valid for correct signature and fresh timestamp', () => {
    const ts = makeTimestamp();
    const sig = computeSlackSignature(body, ts, secret);
    const result = verifySlackRequest(body, ts, sig, secret);
    expect(result).toEqual({ valid: true });
  });

  it('returns missing_timestamp when timestamp is undefined', () => {
    const result = verifySlackRequest(body, undefined, 'v0=abc', secret);
    expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
  });

  it('returns missing_timestamp when timestamp is empty string', () => {
    const result = verifySlackRequest(body, '', 'v0=abc', secret);
    expect(result).toEqual({ valid: false, reason: 'missing_timestamp' });
  });

  it('returns missing_signature when signature is undefined', () => {
    const ts = makeTimestamp();
    const result = verifySlackRequest(body, ts, undefined, secret);
    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('returns stale_timestamp for expired requests', () => {
    const staleTs = makeTimestamp(-SLACK_REPLAY_TOLERANCE_SECS - 1);
    const sig = computeSlackSignature(body, staleTs, secret);
    const result = verifySlackRequest(body, staleTs, sig, secret);
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('returns stale_timestamp for far-future requests', () => {
    const futureTs = makeTimestamp(SLACK_REPLAY_TOLERANCE_SECS + 1);
    const sig = computeSlackSignature(body, futureTs, secret);
    const result = verifySlackRequest(body, futureTs, sig, secret);
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('returns invalid_signature for wrong signing secret', () => {
    const ts = makeTimestamp();
    const sig = computeSlackSignature(body, ts, 'wrong-secret');
    const result = verifySlackRequest(body, ts, sig, secret);
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('returns invalid_signature for tampered body', () => {
    const ts = makeTimestamp();
    const sig = computeSlackSignature(body, ts, secret);
    const result = verifySlackRequest('tampered-body', ts, sig, secret);
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('returns invalid_signature for mismatched signature length (no crash)', () => {
    const ts = makeTimestamp();
    // This would crash the old events.ts verifySlackRequest (buffer-length bug)
    const result = verifySlackRequest(body, ts, 'v0=short', secret);
    expect(result).toEqual({ valid: false, reason: 'invalid_signature' });
  });

  it('returns invalid_signature for empty signature string', () => {
    const ts = makeTimestamp();
    const result = verifySlackRequest(body, ts, '', secret);
    expect(result).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('checks timestamp before signature (cheaper check first)', () => {
    const staleTs = makeTimestamp(-SLACK_REPLAY_TOLERANCE_SECS - 1);
    // Even with a correct signature, stale timestamp should be caught first
    const sig = computeSlackSignature(body, staleTs, secret);
    const result = verifySlackRequest(body, staleTs, sig, secret);
    expect(result.reason).toBe('stale_timestamp');
  });
});
