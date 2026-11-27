/**
 * Referral milestone tiers: the inviter earns `credits` once `friends` of the people they referred are
 * active (a verified email and a first answer). Stored in the ReferralMilestones setting as
 * `friends:credits` pairs separated by commas, e.g. `5:500, 10:1500, 25:5000`. Paid by
 * packages/server-utils/src/referrals/milestoneReward.ts.
 */
export type ReferralMilestone = { friends: number; credits: number };

export const MAX_REFERRAL_MILESTONES = 10;
const MAX_MILESTONE_FRIENDS = 10_000;
const MAX_MILESTONE_CREDITS = 100_000_000;
const ENTRY = /^(\d+)\s*:\s*(\d+)$/;

/**
 * The tiers a ReferralMilestones value names, sorted by friend count; [] for an empty value. Null when the
 * value is malformed: a bad entry, a friend count of 0 or above 10,000, a credit amount of 0 or above
 * 100,000,000, a friend count listed twice, or more than 10 tiers.
 */
export function parseReferralMilestones(value: string): ReferralMilestone[] | null {
  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_REFERRAL_MILESTONES) return null;
  const milestones: ReferralMilestone[] = [];
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    if (!match) return null;
    const friends = Number(match[1]);
    const credits = Number(match[2]);
    if (friends < 1 || friends > MAX_MILESTONE_FRIENDS) return null;
    if (credits < 1 || credits > MAX_MILESTONE_CREDITS) return null;
    if (milestones.some(milestone => milestone.friends === friends)) return null;
    milestones.push({ friends, credits });
  }
  return milestones.sort((a, b) => a.friends - b.friends);
}
