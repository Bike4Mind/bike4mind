import { describe, expect, it } from 'vitest';
import { MAX_REFERRAL_MILESTONES, parseReferralMilestones } from './referralMilestones';

describe('parseReferralMilestones', () => {
  it('reads an empty value as no milestones', () => {
    expect(parseReferralMilestones('')).toEqual([]);
    expect(parseReferralMilestones(' , ')).toEqual([]);
  });

  it('reads friends:credits pairs in any order, sorted by friend count', () => {
    expect(parseReferralMilestones('10:1500, 5 : 500,25:5000')).toEqual([
      { friends: 5, credits: 500 },
      { friends: 10, credits: 1500 },
      { friends: 25, credits: 5000 },
    ]);
  });

  it('accepts the bounds', () => {
    expect(parseReferralMilestones('1:1, 10000:100000000')).toEqual([
      { friends: 1, credits: 1 },
      { friends: 10000, credits: 100000000 },
    ]);
  });

  it.each([
    ['a missing amount', '5:'],
    ['a decimal', '5:1.5'],
    ['a negative', '5:-100'],
    ['words', 'five:500'],
    ['a semicolon separator', '5:500; 10:1000'],
    ['zero friends', '0:500'],
    ['zero credits', '5:0'],
    ['too many friends', '10001:500'],
    ['too many credits', '5:100000001'],
    ['a repeated friend count', '5:500, 5:900'],
  ])('rejects %s', (_label, value) => {
    expect(parseReferralMilestones(value)).toBeNull();
  });

  it(`allows at most ${MAX_REFERRAL_MILESTONES} tiers`, () => {
    const tiers = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}:100`).join(',');
    expect(parseReferralMilestones(tiers(MAX_REFERRAL_MILESTONES))).toHaveLength(MAX_REFERRAL_MILESTONES);
    expect(parseReferralMilestones(tiers(MAX_REFERRAL_MILESTONES + 1))).toBeNull();
  });
});
