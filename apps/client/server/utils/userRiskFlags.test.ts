import { describe, it, expect } from 'vitest';
import { adminUserRiskFlagsSchema } from '@bike4mind/common';
import {
  RISK_RULE_CONFIG,
  evaluateCreditSpike,
  evaluateFailedSignIns,
  evaluateModeration,
  evaluateNewSignIn,
  evaluateUserRisk,
  type RiskDailyCredits,
  type RiskSignIn,
} from './userRiskFlags';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const failed = (n: number, ageMs = HOUR, event = 'step_up_failed'): RiskSignIn[] =>
  Array.from({ length: n }, (_, i) => ({ at: ago(ageMs + i * 1000), result: 'failed', event }));
const success = (ageMs: number, ip?: string, extra: Partial<RiskSignIn> = {}): RiskSignIn => ({
  at: ago(ageMs),
  result: 'success',
  event: 'login_success',
  ip,
  ...extra,
});

describe('evaluateFailedSignIns', () => {
  const { threshold } = RISK_RULE_CONFIG.failedSignIns;
  it('does not fire below the threshold', () => {
    expect(evaluateFailedSignIns(failed(threshold - 1), NOW)).toBeNull();
  });
  it('fires at the threshold and counts blocked as well as failed', () => {
    const entries = [
      ...failed(threshold - 1),
      { at: ago(HOUR), result: 'blocked', event: 'session_reuse_revoked' } as RiskSignIn,
    ];
    const flag = evaluateFailedSignIns(entries, NOW);
    expect(flag).toMatchObject({ id: 'failed_sign_ins', severity: 'warn' });
    expect(flag?.evidence[0]).toEqual({ label: 'Failed or blocked sign-ins', value: String(threshold) });
  });
  it('is high at twice the threshold', () => {
    expect(evaluateFailedSignIns(failed(threshold * 2), NOW)?.severity).toBe('high');
  });
  it('ignores attempts outside the window and successes', () => {
    const old = failed(threshold, RISK_RULE_CONFIG.failedSignIns.windowHours * HOUR + 1);
    expect(evaluateFailedSignIns([...old, ...Array.from({ length: 10 }, () => success(HOUR))], NOW)).toBeNull();
  });
  it('counts an attempt exactly at the window start', () => {
    const at = ago(RISK_RULE_CONFIG.failedSignIns.windowHours * HOUR);
    const entries = failed(threshold).map(e => ({ ...e, at }));
    expect(evaluateFailedSignIns(entries, NOW)?.id).toBe('failed_sign_ins');
  });
  it('handles an empty list', () => {
    expect(evaluateFailedSignIns([], NOW)).toBeNull();
  });
});

describe('evaluateNewSignIn', () => {
  const prior = (n: number) => Array.from({ length: n }, (_, i) => success(10 * DAY + i * DAY, '10.0.0.1'));
  it('fires when a recent success comes from an IP absent from earlier successes', () => {
    const flag = evaluateNewSignIn([success(HOUR, '203.0.113.9'), ...prior(3)], NOW);
    expect(flag).toMatchObject({ id: 'new_ip_or_device', severity: 'info' });
    expect(flag?.evidence).toContainEqual({ label: 'New IP address', value: '203.0.113.9' });
  });
  it('does not fire for a known IP', () => {
    expect(evaluateNewSignIn([success(HOUR, '10.0.0.1'), ...prior(3)], NOW)).toBeNull();
  });
  it('does not fire with fewer prior successes than the minimum', () => {
    expect(evaluateNewSignIn([success(HOUR, '203.0.113.9'), ...prior(2)], NOW)).toBeNull();
  });
  it('fires on a new device when the IP is known', () => {
    const device = { browser: 'Firefox', operatingSystem: 'Linux' };
    const earlier = prior(3).map(e => ({ ...e, browser: 'Chrome', operatingSystem: 'macOS' }));
    const flag = evaluateNewSignIn([success(HOUR, '10.0.0.1', device), ...earlier], NOW);
    expect(flag?.evidence).toContainEqual({ label: 'New device', value: 'Firefox, Linux' });
  });
  it('does not flag a new device when only deviceType differs between prior and recent sign-ins', () => {
    const base = { browser: 'Chrome', operatingSystem: 'macOS' };
    const earlier = prior(3).map(e => ({ ...e, ...base }));
    const recent = success(HOUR, '10.0.0.1', { ...base, deviceType: 'Desktop' } as Partial<RiskSignIn>);
    expect(evaluateNewSignIn([recent, ...earlier], NOW)).toBeNull();
  });
  it('ignores missing and Unknown IPs', () => {
    expect(evaluateNewSignIn([success(HOUR, undefined), success(2 * HOUR, 'Unknown'), ...prior(3)], NOW)).toBeNull();
  });
  it('ignores failed attempts from a new IP', () => {
    const entries = [{ ...success(HOUR, '203.0.113.9'), result: 'failed' as const }, ...prior(3)];
    expect(evaluateNewSignIn(entries, NOW)).toBeNull();
  });
  it('handles an empty list', () => {
    expect(evaluateNewSignIn([], NOW)).toBeNull();
  });
});

describe('evaluateCreditSpike', () => {
  const cfg = RISK_RULE_CONFIG.creditSpike;
  const day = (ageDays: number) =>
    ago(ageDays * DAY)
      .toISOString()
      .slice(0, 10);
  const series = (baselinePerDay: number, baselineDays: number, recentPerDay: number): RiskDailyCredits[] => [
    ...Array.from({ length: baselineDays }, (_, i) => ({ day: day(cfg.recentDays + i), credits: baselinePerDay })),
    ...Array.from({ length: cfg.recentDays }, (_, i) => ({ day: day(i), credits: recentPerDay })),
  ];
  it('fires when recent spend is at least multiplier x the baseline rate', () => {
    // baseline 10/day => 70 per 7 days; 3x = 210; recent 30/day = 210 exactly (boundary)
    const flag = evaluateCreditSpike(series(10, 30, 30), NOW);
    expect(flag).toMatchObject({ id: 'credit_spike', severity: 'warn' });
    expect(flag?.evidence[0]).toEqual({ label: 'Credits spent, last 7 days', value: '210' });
  });
  it('links to the usage timeline, which is what the spike measures', () => {
    expect(evaluateCreditSpike(series(10, 30, 30), NOW)?.timeline?.types).toEqual(['usage']);
  });
  it('does not fire just below the multiplier', () => {
    expect(evaluateCreditSpike(series(10, 30, 29), NOW)).toBeNull();
  });
  it('is high at twice the multiplier', () => {
    expect(evaluateCreditSpike(series(10, 30, 60), NOW)?.severity).toBe('high');
  });
  it('does not fire for a new account with too few baseline days', () => {
    expect(evaluateCreditSpike(series(10, cfg.minBaselineActiveDays - 1, 500), NOW)).toBeNull();
  });
  it('does not fire when the baseline is below the credit floor', () => {
    expect(evaluateCreditSpike(series(1, 30, 500), NOW)).toBeNull();
  });
  it('does not fire when recent spend is below the floor', () => {
    expect(evaluateCreditSpike(series(5, 30, 20), NOW)).toBeNull();
  });
  it('handles an empty series', () => {
    expect(evaluateCreditSpike([], NOW)).toBeNull();
  });
});

describe('evaluateModeration', () => {
  it('fires on one incident inside the window and names its labels', () => {
    const flag = evaluateModeration([{ createdAt: ago(DAY), labels: [{ name: 'Explicit Nudity' }] }], NOW);
    expect(flag?.id).toBe('prior_moderation');
    expect(flag?.evidence).toContainEqual({ label: 'Labels', value: 'Explicit Nudity' });
  });
  it('ignores incidents reviewed as false positives', () => {
    const incident = { createdAt: ago(DAY), reviewStatus: 'false_positive' };
    expect(evaluateModeration([incident], NOW)).toBeNull();
    expect(evaluateModeration([incident, { createdAt: ago(DAY), reviewStatus: 'confirmed_csam' }], NOW)).not.toBeNull();
  });
  it('ignores incidents outside the window', () => {
    const age = RISK_RULE_CONFIG.moderation.windowDays * DAY + 1;
    expect(evaluateModeration([{ createdAt: ago(age) }], NOW)).toBeNull();
  });
  it('handles an empty list', () => {
    expect(evaluateModeration([], NOW)).toBeNull();
  });
});

describe('evaluateUserRisk', () => {
  it('returns no flags for a user with no history', () => {
    expect(evaluateUserRisk({ signIns: [], dailyCredits: [], moderationIncidents: [] }, NOW)).toEqual([]);
  });
  it('returns schema-valid flags with ASCII-only text and no score', () => {
    const flags = evaluateUserRisk(
      {
        signIns: failed(6),
        dailyCredits: [],
        moderationIncidents: [{ createdAt: ago(DAY), labels: [{ name: 'X' }] }],
      },
      NOW
    );
    expect(flags.map(f => f.id)).toEqual(['failed_sign_ins', 'prior_moderation']);
    const parsed = adminUserRiskFlagsSchema.parse({ flags });
    expect(JSON.stringify(parsed)).not.toMatch(/[^\x20-\x7e]/);
    expect(JSON.stringify(parsed)).not.toMatch(/score/i);
  });
});
