import { describe, it, expect } from 'vitest';
import {
  LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS,
  LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS,
  LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS,
  LAKE_ACCESS_QUERY_TEXT_RETENTION_MAX_DAYS,
  LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS,
  lakeAccessExpiresAt,
  resolveLakeAccessAuditRetentionDays,
  resolveLakeAccessQueryTextRetentionDays,
} from '../lakeAccessAudit';

describe('resolveLakeAccessAuditRetentionDays', () => {
  it('defaults on undefined, null, and empty string', () => {
    expect(resolveLakeAccessAuditRetentionDays(undefined)).toBe(LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
    expect(resolveLakeAccessAuditRetentionDays(null)).toBe(LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
  });

  it('never allows below the floor - the whole point of this function', () => {
    expect(resolveLakeAccessAuditRetentionDays(0)).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
    expect(resolveLakeAccessAuditRetentionDays(1)).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
    expect(resolveLakeAccessAuditRetentionDays(-100)).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
    expect(resolveLakeAccessAuditRetentionDays(NaN)).toBe(LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
  });

  it('clamps above the ceiling', () => {
    expect(resolveLakeAccessAuditRetentionDays(10_000)).toBe(LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS);
  });

  it('floors fractional values before clamping', () => {
    expect(resolveLakeAccessAuditRetentionDays(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS + 10.9)).toBe(
      LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS + 10
    );
  });

  it('passes through a valid in-range value unchanged', () => {
    expect(resolveLakeAccessAuditRetentionDays(600)).toBe(600);
  });
});

describe('resolveLakeAccessQueryTextRetentionDays', () => {
  it('defaults on undefined/null within the dynamic bound', () => {
    const days = resolveLakeAccessQueryTextRetentionDays(undefined, LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
    expect(days).toBeGreaterThanOrEqual(LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS);
    expect(days).toBeLessThan(LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
  });

  it('is always strictly less than the audit retention, even at the floor boundary', () => {
    const auditDays = LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS;
    const queryDays = resolveLakeAccessQueryTextRetentionDays(auditDays, auditDays);
    expect(queryDays).toBeLessThan(auditDays);
  });

  it('is capped by the static max even when the audit retention is huge', () => {
    expect(resolveLakeAccessQueryTextRetentionDays(10_000, LAKE_ACCESS_AUDIT_RETENTION_MAX_DAYS)).toBe(
      LAKE_ACCESS_QUERY_TEXT_RETENTION_MAX_DAYS
    );
  });

  it('never goes below the minimum', () => {
    expect(resolveLakeAccessQueryTextRetentionDays(-5, LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS)).toBe(
      LAKE_ACCESS_QUERY_TEXT_RETENTION_MIN_DAYS
    );
  });
});

describe('lakeAccessExpiresAt', () => {
  it('adds the given number of days in milliseconds', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const result = lakeAccessExpiresAt(now, 10);
    expect(result.getTime() - now.getTime()).toBe(10 * 24 * 60 * 60 * 1000);
  });
});
