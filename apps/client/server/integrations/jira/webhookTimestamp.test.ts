import { describe, it, expect } from 'vitest';
import { validateJiraPayloadTimestamp, JIRA_REPLAY_TOLERANCE_MS } from './webhookUtils';

describe('validateJiraPayloadTimestamp', () => {
  const nowMs = 1700000000000; // fixed reference point

  it('returns valid for undefined timestamp (pass-through)', () => {
    const result = validateJiraPayloadTimestamp(undefined, nowMs);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid for null timestamp (pass-through)', () => {
    const result = validateJiraPayloadTimestamp(null, nowMs);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid for a timestamp within tolerance', () => {
    const result = validateJiraPayloadTimestamp(nowMs - 60_000, nowMs); // 1 min ago
    expect(result).toEqual({ valid: true });
  });

  it('returns valid for exactly at tolerance boundary', () => {
    const result = validateJiraPayloadTimestamp(nowMs - JIRA_REPLAY_TOLERANCE_MS, nowMs);
    expect(result).toEqual({ valid: true });
  });

  it('returns timestamp_expired for 1ms past tolerance', () => {
    const result = validateJiraPayloadTimestamp(nowMs - JIRA_REPLAY_TOLERANCE_MS - 1, nowMs);
    expect(result).toEqual({ valid: false, reason: 'timestamp_expired' });
  });

  it('returns valid for a future timestamp within tolerance', () => {
    const result = validateJiraPayloadTimestamp(nowMs + 60_000, nowMs); // 1 min in future
    expect(result).toEqual({ valid: true });
  });

  it('returns timestamp_expired for a far-future timestamp', () => {
    const result = validateJiraPayloadTimestamp(nowMs + JIRA_REPLAY_TOLERANCE_MS + 1, nowMs);
    expect(result).toEqual({ valid: false, reason: 'timestamp_expired' });
  });

  it('returns invalid_timestamp for zero', () => {
    const result = validateJiraPayloadTimestamp(0, nowMs);
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('returns invalid_timestamp for negative number', () => {
    const result = validateJiraPayloadTimestamp(-1, nowMs);
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('returns invalid_timestamp for NaN string', () => {
    const result = validateJiraPayloadTimestamp('not-a-number', nowMs);
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('handles string-encoded numeric timestamps', () => {
    const result = validateJiraPayloadTimestamp(String(nowMs - 60_000), nowMs);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid_timestamp for empty string', () => {
    const result = validateJiraPayloadTimestamp('', nowMs);
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('returns invalid_timestamp for Infinity', () => {
    const result = validateJiraPayloadTimestamp(Infinity, nowMs);
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('uses Date.now() when nowMs not provided', () => {
    const result = validateJiraPayloadTimestamp(Date.now());
    expect(result).toEqual({ valid: true });
  });
});
