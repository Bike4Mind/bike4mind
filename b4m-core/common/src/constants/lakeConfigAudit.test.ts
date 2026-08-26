import { describe, it, expect } from 'vitest';
import {
  LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS,
  LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS,
  LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS,
  LAKE_CONFIG_TEXT_HASH_CHARS,
  LAKE_CONFIG_VALUE_MAX_CHARS,
  capLakeConfigValue,
  lakeConfigExpiresAt,
  lakeConfigTextFingerprint,
  resolveLakeConfigAuditRetentionDays,
} from './lakeConfigAudit';
import { LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS } from './lakeAccessAudit';

describe('resolveLakeConfigAuditRetentionDays', () => {
  it('returns the default for every shape of "not configured"', () => {
    for (const input of [undefined, null, NaN, Infinity]) {
      expect(resolveLakeConfigAuditRetentionDays(input as number)).toBe(LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS);
    }
  });

  it('ratchets UP to the floor - the point of the lever, not a formality', () => {
    expect(resolveLakeConfigAuditRetentionDays(1)).toBe(LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS);
    expect(resolveLakeConfigAuditRetentionDays(0)).toBe(LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS);
    expect(resolveLakeConfigAuditRetentionDays(-9999)).toBe(LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS);
  });

  it('clamps down to the ceiling and keeps an in-range value', () => {
    expect(resolveLakeConfigAuditRetentionDays(999999)).toBe(LAKE_CONFIG_AUDIT_RETENTION_MAX_DAYS);
    expect(resolveLakeConfigAuditRetentionDays(2000)).toBe(2000);
  });

  it('floors a fractional day rather than storing a partial one', () => {
    expect(resolveLakeConfigAuditRetentionDays(2000.9)).toBe(2000);
  });

  // The separate collection only earns its keep if it actually keeps rows longer than the read
  // audit does. If someone ever "harmonizes" the two defaults, this is the argument they broke.
  it('keeps config events substantially longer than access events', () => {
    expect(LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS).toBeGreaterThan(LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS);
  });
});

describe('lakeConfigExpiresAt', () => {
  it('adds whole days to the given instant', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(lakeConfigExpiresAt(now, 2).toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });
});

describe('lakeConfigTextFingerprint', () => {
  it('reports every blank form as absent, with no hash to leak', () => {
    for (const input of [undefined, null, '', '   ', '\n\t ']) {
      expect(lakeConfigTextFingerprint(input)).toEqual({ present: false, length: 0, hash: '' });
    }
  });

  it('never contains the text it describes', () => {
    const secret = 'Answer only in the voice of the acquiring party';
    const fingerprint = lakeConfigTextFingerprint(secret);
    expect(JSON.stringify(fingerprint)).not.toContain('acquiring');
    expect(fingerprint.present).toBe(true);
    expect(fingerprint.hash).toHaveLength(LAKE_CONFIG_TEXT_HASH_CHARS);
  });

  it('is stable for the same text and different for different text - what makes a revert legible', () => {
    expect(lakeConfigTextFingerprint('alpha').hash).toBe(lakeConfigTextFingerprint('alpha').hash);
    expect(lakeConfigTextFingerprint('alpha').hash).not.toBe(lakeConfigTextFingerprint('beta').hash);
  });

  it('trims before hashing, so re-saving a prompt with new padding is not a change', () => {
    expect(lakeConfigTextFingerprint('  alpha  ')).toEqual(lakeConfigTextFingerprint('alpha'));
  });

  it('counts code points, not UTF-16 units', () => {
    // Four astral-plane emoji: 8 UTF-16 units, 4 characters.
    expect(lakeConfigTextFingerprint('\u{1F600}\u{1F601}\u{1F602}\u{1F603}').length).toBe(4);
  });
});

describe('capLakeConfigValue', () => {
  it('passes a value at the cap through untouched', () => {
    const exact = 'a'.repeat(LAKE_CONFIG_VALUE_MAX_CHARS);
    expect(capLakeConfigValue(exact)).toEqual({ value: exact, truncated: false });
  });

  it('truncates past the cap and says so', () => {
    const long = 'a'.repeat(LAKE_CONFIG_VALUE_MAX_CHARS + 1);
    const capped = capLakeConfigValue(long);
    expect(capped.truncated).toBe(true);
    expect(Array.from(capped.value)).toHaveLength(LAKE_CONFIG_VALUE_MAX_CHARS);
  });

  it('never splits a surrogate pair at the boundary', () => {
    const emoji = '\u{1F600}'.repeat(LAKE_CONFIG_VALUE_MAX_CHARS + 10);
    const capped = capLakeConfigValue(emoji);
    // A UTF-16 slice would leave a lone surrogate here, which renders as U+FFFD.
    expect(capped.value).not.toContain('\uFFFD');
    expect(Array.from(capped.value)).toHaveLength(LAKE_CONFIG_VALUE_MAX_CHARS);
  });
});
