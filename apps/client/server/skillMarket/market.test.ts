import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: async (key: string) => settings.get(key) },
  inboxRepository: { createInboxMessage: vi.fn() },
  SkillListing: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));

import { loadMarketSettings, meetsPublicAccountAge, numericSetting } from './market';

describe('numericSetting', () => {
  it.each([undefined, null, '', 'abc', NaN, Infinity, -Infinity])('falls back on %s', value => {
    expect(numericSetting(value, 7)).toBe(7);
  });

  it('parses numbers and numeric strings, keeping 0 unless positive is required', () => {
    expect(numericSetting('0.5', 7)).toBe(0.5);
    expect(numericSetting(0, 7)).toBe(0);
    expect(numericSetting(0, 7, { positive: true })).toBe(7);
    expect(numericSetting(-3, 7, { positive: true })).toBe(7);
    expect(numericSetting('12', 7, { positive: true })).toBe(12);
  });
});

describe('meetsPublicAccountAge', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const minAge = { publicMinAccountAgeDays: 3 };

  it('passes an account at or past the minimum age and refuses a younger one', () => {
    expect(meetsPublicAccountAge({ createdAt: new Date(Date.now() - 3 * DAY_MS - 1000) }, minAge)).toBe(true);
    expect(meetsPublicAccountAge({ createdAt: new Date(Date.now() - 2 * DAY_MS) }, minAge)).toBe(false);
  });

  it('always passes a super-admin, even a new one', () => {
    expect(meetsPublicAccountAge({ isAdmin: true, createdAt: new Date() }, minAge)).toBe(true);
  });

  it('fails closed when the account has no creation date', () => {
    expect(meetsPublicAccountAge({}, minAge)).toBe(false);
  });
});

describe('loadMarketSettings', () => {
  beforeEach(() => settings.clear());

  it('uses the defaults when every numeric setting is unset', async () => {
    expect(await loadMarketSettings()).toMatchObject({
      minConfidence: 0.8,
      auditSampleRate: 0.1,
      reviewSlaHours: 72,
      dailySubmitLimit: 20,
      maxListingsPerUser: 25,
      publicMinAccountAgeDays: 3,
      reportAutoHideThreshold: 3,
    });
  });

  it('never yields NaN or a zero cap from a malformed value', async () => {
    for (const key of [
      'SkillMarketClassifierMinConfidence',
      'SkillMarketAuditSampleRate',
      'SkillMarketReviewSlaHours',
      'SkillMarketDailySubmitLimit',
      'SkillMarketMaxListingsPerUser',
      'SkillMarketPublicMinAccountAgeDays',
    ]) {
      settings.set(key, 'abc');
    }
    settings.set('SkillMarketReportAutoHideThreshold', 0);
    const loaded = await loadMarketSettings();
    expect(loaded).toMatchObject({
      minConfidence: 0.8,
      auditSampleRate: 0.1,
      reviewSlaHours: 72,
      dailySubmitLimit: 20,
      maxListingsPerUser: 25,
      publicMinAccountAgeDays: 3,
      reportAutoHideThreshold: 3,
    });
  });

  it('honours valid admin values, including a zero sample rate and age gate', async () => {
    settings.set('SkillMarketAuditSampleRate', '0');
    settings.set('SkillMarketPublicMinAccountAgeDays', 0);
    settings.set('SkillMarketMaxListingsPerUser', '5');
    expect(await loadMarketSettings()).toMatchObject({
      auditSampleRate: 0,
      publicMinAccountAgeDays: 0,
      maxListingsPerUser: 5,
    });
  });
});
