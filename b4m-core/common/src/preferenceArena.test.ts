import { describe, it, expect } from 'vitest';
import {
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
  it('resolves an empty map to disabled and zeroed', () => {
    expect(resolvePreferenceArenaSettings({})).toEqual({
      enabled: false,
      creditsPerVote: 0,
      dailyVoteCap: 0,
      lifetimeCreditCap: 0,
      minResponseMs: 0,
      goldRatePercent: 0,
      minGoldVotes: 0,
      minGoldAccuracyPercent: 0,
    });
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
    signupGrant: { stage: 'unlocked' as const, unlockedBy: 'github_verified' as const },
  };

  it('accepts a verified user unlocked by a human-proving method', () => {
    expect(isArenaVerifiedUser(verified)).toBe(true);
  });

  it('rejects unverified email, synthetic, deleted and missing grants', () => {
    expect(isArenaVerifiedUser({ ...verified, emailVerified: false })).toBe(false);
    expect(isArenaVerifiedUser({ ...verified, isSynthetic: true })).toBe(false);
    expect(isArenaVerifiedUser({ ...verified, deletedAt: new Date() })).toBe(false);
    expect(isArenaVerifiedUser({ emailVerified: true })).toBe(false);
  });

  it('rejects a grant that is not unlocked or was unlocked by a non-proving method', () => {
    expect(isArenaVerifiedUser({ ...verified, signupGrant: { stage: 'locked' as never } })).toBe(false);
    expect(isArenaVerifiedUser({ ...verified, signupGrant: { stage: 'unlocked', unlockedBy: 'admin' as never } })).toBe(
      false
    );
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
    expect(judgeArenaVote(context({ settings: { ...settings, minGoldVotes: 0 } }))).toEqual({
      accepted: false,
      reason: 'unqualified',
    });
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
