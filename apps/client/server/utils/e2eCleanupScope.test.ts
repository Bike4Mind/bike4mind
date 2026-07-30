import { describe, it, expect } from 'vitest';
import {
  BASE_E2E_EMAIL_PATTERN,
  DEFAULT_STALE_SWEEP_MINUTES,
  MIN_STALE_SWEEP_MINUTES,
  buildE2EEmailPattern,
  resolveStaleSweepMinutes,
  sanitizeTestId,
} from './e2eCleanupScope';

describe('buildE2EEmailPattern', () => {
  it('matches only the run that owns the testId', () => {
    const pattern = buildE2EEmailPattern('gh30421366842');
    expect(pattern.test('setup-admin-gh30421366842-1769000000000-e2e@test.com')).toBe(true);
    expect(pattern.test('setup-admin-gh30327348536-1769000000000-e2e@test.com')).toBe(false);
  });

  it('does not match a longer testId that ends with it', () => {
    const pattern = buildE2EEmailPattern('gh12');
    expect(pattern.test('setup-admin-alicegh12-1769000000000-e2e@test.com')).toBe(false);
    expect(pattern.test('setup-admin-gh12-1769000000000-e2e@test.com')).toBe(true);
  });

  it('matches the retry-marker emails auth.spec builds', () => {
    const pattern = buildE2EEmailPattern('gh99');
    expect(pattern.test('auth-logout0-gh99-1769000000000-e2e@test.com')).toBe(true);
  });

  it('falls back to the unscoped base pattern when no testId is given', () => {
    expect(buildE2EEmailPattern('')).toBe(BASE_E2E_EMAIL_PATTERN);
  });

  it('never matches the standing seeded QA accounts', () => {
    for (const pattern of [buildE2EEmailPattern(''), buildE2EEmailPattern('gh1')]) {
      expect(pattern.test('qa-admin-e2e@test.com')).toBe(false);
      expect(pattern.test('qa-user-e2e@test.com')).toBe(false);
    }
  });
});

describe('sanitizeTestId', () => {
  it('strips everything outside the alphanumeric class, matching getE2ETestId', () => {
    expect(sanitizeTestId('alice-gh30421366842')).toBe('alicegh30421366842');
  });

  it('neutralizes regex metacharacters so the id cannot alter the pattern', () => {
    expect(sanitizeTestId('.*')).toBe('');
    const pattern = buildE2EEmailPattern(sanitizeTestId('a.*b'));
    expect(pattern.test('setup-admin-aXXb-1769000000000-e2e@test.com')).toBe(false);
    expect(pattern.test('setup-admin-ab-1769000000000-e2e@test.com')).toBe(true);
  });

  it('returns empty for non-string input', () => {
    expect(sanitizeTestId(undefined)).toBe('');
    expect(sanitizeTestId(['a', 'b'])).toBe('');
  });
});

describe('base pattern coverage', () => {
  // The aged sweep is the only thing that reaches these: they carry no testId segment, so no
  // scoped pattern matches them and nothing else would ever collect them.
  it('matches the spec emails that carry no testId segment', () => {
    for (const email of [
      'mfa-signin-1769000000000-e2e@test.com',
      'admin-1769000000000-e2e@test.com',
      'signup-1769000000000-e2e@test.com',
      'inline-signup-1769000000000-e2e@test.com',
    ]) {
      expect(BASE_E2E_EMAIL_PATTERN.test(email)).toBe(true);
      expect(buildE2EEmailPattern('gh30421366842').test(email)).toBe(false);
    }
  });

  it('matches the truncated run ids core.setup and the specs actually produce', () => {
    // core.setup.ts uses Date.now().slice(-8), other specs slice(-6) - short, not epoch ms.
    expect(BASE_E2E_EMAIL_PATTERN.test('setup-admin-51900411-e2e@test.com')).toBe(true);
    expect(BASE_E2E_EMAIL_PATTERN.test('setup-agents-004119-e2e@test.com')).toBe(true);
  });
});

describe('resolveStaleSweepMinutes', () => {
  it('defaults when the caller sends nothing usable', () => {
    expect(resolveStaleSweepMinutes(undefined)).toBe(DEFAULT_STALE_SWEEP_MINUTES);
    expect(resolveStaleSweepMinutes('not-a-number')).toBe(DEFAULT_STALE_SWEEP_MINUTES);
  });

  it('honors a window at or above the floor', () => {
    expect(resolveStaleSweepMinutes('720')).toBe(720);
    expect(resolveStaleSweepMinutes(String(MIN_STALE_SWEEP_MINUTES))).toBe(MIN_STALE_SWEEP_MINUTES);
  });

  it('clamps up so a small window cannot reach a live run', () => {
    expect(resolveStaleSweepMinutes('0')).toBe(MIN_STALE_SWEEP_MINUTES);
    expect(resolveStaleSweepMinutes('-1')).toBe(MIN_STALE_SWEEP_MINUTES);
    expect(resolveStaleSweepMinutes('5')).toBe(MIN_STALE_SWEEP_MINUTES);
  });

  it('keeps the floor above the longest allowed CI run', () => {
    expect(MIN_STALE_SWEEP_MINUTES).toBeGreaterThan(90);
  });
});
