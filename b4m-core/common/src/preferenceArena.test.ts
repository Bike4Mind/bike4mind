import { describe, it, expect } from 'vitest';
import {
  ARENA_QUALITY_DEFAULTS,
  arenaRaterStanding,
  isArenaVerifiedUser,
  judgeArenaVote,
  resolvePreferenceArenaSettings,
  type ArenaVoteContext,
  type PreferenceArenaSettings,
} from './preferenceArena';

const settings: PreferenceArenaSettings = {
  enabled: true,
  creditsPerVote: 2,
  dailyVoteCap: 10,
  lifetimeCreditCap: 50,
  minResponseMs: 3000,
  goldRatePercent: 20,
  minGoldVotes: 5,
  minGoldAccuracyPercent: 70,
};

const context = (over: Partial<ArenaVoteContext> = {}): ArenaVoteContext => ({
  settings,
  responseMs: 8000,
  goldCorrect: null,
  goldAnswered: 10,
  goldCorrectTotal: 9,
  creditedVotesToday: 0,
  creditsEarnedLifetime: 0,
  ...over,
});

describe('resolvePreferenceArenaSettings', () => {
  it('resolves an empty map to disabled, unpaid, and default quality gates', () => {
    expect(resolvePreferenceArenaSettings({})).toEqual({
      enabled: false,
      creditsPerVote: 0,
      dailyVoteCap: 0,
      lifetimeCreditCap: 0,
      ...ARENA_QUALITY_DEFAULTS,
    });
  });

  it('keeps an explicit 0 quality gate rather than falling back to the default', () => {
    const resolved = resolvePreferenceArenaSettings({
      preferenceArenaMinResponseMs: '0',
      preferenceArenaMinGoldVotes: '',
    });
    expect(resolved.minResponseMs).toBe(0);
    expect(resolved.minGoldVotes).toBe(ARENA_QUALITY_DEFAULTS.minGoldVotes);
  });

  it('parses stored string values', () => {
    const resolved = resolvePreferenceArenaSettings({
      preferenceArenaEnabled: 'true',
      preferenceArenaCreditsPerVote: '3',
      preferenceArenaGoldRatePercent: '250',
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.creditsPerVote).toBe(3);
    expect(resolved.goldRatePercent).toBe(100);
  });

  it.each(['abc', '', '-4', '1.5', 'Infinity', null, undefined])('treats %p as 0', raw => {
    expect(resolvePreferenceArenaSettings({ preferenceArenaDailyVoteCap: raw }).dailyVoteCap).toBe(0);
  });

  it('does not enable on a malformed flag', () => {
    expect(resolvePreferenceArenaSettings({ preferenceArenaEnabled: 'yes' }).enabled).toBe(false);
  });
});

describe('isArenaVerifiedUser', () => {
  const verified = {
    emailVerified: true,
    signupGrant: { stage: 'unlocked' as const, unlockedBy: 'card_verified' as const },
  };

  it('accepts a signup grant unlocked by card or phone', () => {
    expect(isArenaVerifiedUser(verified)).toBe(true);
    expect(isArenaVerifiedUser({ ...verified, signupGrant: { stage: 'unlocked', unlockedBy: 'phone_verified' } })).toBe(
      true
    );
  });

  it('accepts a GitHub or work-email no-card unlock even though the grant was never stamped', () => {
    for (const reason of ['github_verified', 'work_email_verified'] as const) {
      expect(isArenaVerifiedUser({ emailVerified: true, noCardUnlocks: [reason] })).toBe(true);
    }
    expect(isArenaVerifiedUser({ emailVerified: true, noCardUnlocks: [] })).toBe(false);
  });

  it('applies the account checks to a no-card unlock too', () => {
    const unlocked = { emailVerified: true, noCardUnlocks: ['github_verified' as const] };
    expect(isArenaVerifiedUser({ ...unlocked, emailVerified: false })).toBe(false);
    expect(isArenaVerifiedUser({ ...unlocked, isSynthetic: true })).toBe(false);
    expect(isArenaVerifiedUser({ ...unlocked, deletedAt: new Date() })).toBe(false);
  });

  it('rejects unverified email, synthetic, deleted and missing grants', () => {
    expect(isArenaVerifiedUser({ ...verified, emailVerified: false })).toBe(false);
    expect(isArenaVerifiedUser({ ...verified, isSynthetic: true })).toBe(false);
    expect(isArenaVerifiedUser({ ...verified, deletedAt: new Date() })).toBe(false);
    expect(isArenaVerifiedUser({ emailVerified: true })).toBe(false);
  });

  it('rejects a grant that is not unlocked or was unlocked by a non-proving method', () => {
    expect(isArenaVerifiedUser({ ...verified, signupGrant: { stage: 'locked' as never } })).toBe(false);
    for (const unlockedBy of ['admin', 'activity', 'org_invite', 'github_verified', 'work_email_verified'] as const) {
      expect(isArenaVerifiedUser({ ...verified, signupGrant: { stage: 'unlocked', unlockedBy } })).toBe(false);
    }
  });
});

describe('judgeArenaVote', () => {
  it('accepts a clean vote at the configured reward', () => {
    expect(judgeArenaVote(context())).toEqual({ accepted: true, credits: 2 });
  });

  it('rejects with rewards_off when the reward is 0', () => {
    expect(judgeArenaVote(context({ settings: { ...settings, creditsPerVote: 0 } }))).toEqual({
      accepted: false,
      reason: 'rewards_off',
    });
  });

  it('rejects too_fast', () => {
    expect(judgeArenaVote(context({ responseMs: 500 }))).toEqual({ accepted: false, reason: 'too_fast' });
  });

  it('rejects a missed gold question', () => {
    expect(judgeArenaVote(context({ goldCorrect: false }))).toEqual({ accepted: false, reason: 'gold_missed' });
  });

  it('rejects unqualified raters with too few gold answers or no gold bar', () => {
    expect(judgeArenaVote(context({ goldAnswered: 4, goldCorrectTotal: 4 }))).toEqual({
      accepted: false,
      reason: 'unqualified',
    });
  });

  it('keeps rewards off while any quality gate is 0, instead of waving every vote through', () => {
    for (const gate of ['minResponseMs', 'minGoldVotes', 'minGoldAccuracyPercent', 'dailyVoteCap'] as const) {
      expect(judgeArenaVote(context({ settings: { ...settings, [gate]: 0 } }))).toEqual({
        accepted: false,
        reason: 'rewards_off',
      });
    }
  });

  it('rejects low gold accuracy', () => {
    expect(judgeArenaVote(context({ goldAnswered: 10, goldCorrectTotal: 6 }))).toEqual({
      accepted: false,
      reason: 'low_gold_accuracy',
    });
  });

  it('rejects past the daily cap', () => {
    expect(judgeArenaVote(context({ creditedVotesToday: 10 }))).toEqual({ accepted: false, reason: 'daily_cap' });
  });

  it('pays the remainder when the lifetime cap is nearly reached', () => {
    expect(judgeArenaVote(context({ creditsEarnedLifetime: 49 }))).toEqual({ accepted: true, credits: 1 });
  });

  it('rejects at the lifetime cap', () => {
    expect(judgeArenaVote(context({ creditsEarnedLifetime: 50 }))).toEqual({
      accepted: false,
      reason: 'lifetime_cap',
    });
  });
});

describe('arenaRaterStanding', () => {
  it('needs enough gold answers, then splits on accuracy', () => {
    expect(arenaRaterStanding({ answered: 2, correct: 2 }, { ...settings, minGoldVotes: 3 })).toBe('unqualified');
    expect(
      arenaRaterStanding({ answered: 4, correct: 3 }, { ...settings, minGoldVotes: 3, minGoldAccuracyPercent: 75 })
    ).toBe('qualified');
    expect(
      arenaRaterStanding({ answered: 4, correct: 2 }, { ...settings, minGoldVotes: 3, minGoldAccuracyPercent: 75 })
    ).toBe('flagged');
  });

  it('treats nobody as qualified when no gold bar is set', () => {
    expect(arenaRaterStanding({ answered: 5, correct: 5 }, { ...settings, minGoldVotes: 0 })).toBe('unqualified');
  });
});
