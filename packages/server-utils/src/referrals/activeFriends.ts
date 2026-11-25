import { parseReferralMilestones, type ReferralMilestone } from '@bike4mind/common';

/**
 * The referred friends a milestone counts: a verified email and a first answer, the bar the first-answer
 * reward pays on. Also the inviter summary's "active" (apps/client/server/referrals/inviterSummary.ts), so
 * the progress an inviter sees is what pays.
 */
export const activeReferredFriendsFilter = (inviterId: string) => ({
  referredByUserId: inviterId,
  isSynthetic: { $ne: true },
  deletedAt: null,
  emailVerified: true,
  firstValueAt: { $ne: null },
});

/** The configured milestone tiers; [] when unset or malformed (the settings save path refuses a malformed value). */
export function readReferralMilestones(stored: unknown): ReferralMilestone[] {
  return typeof stored === 'string' ? (parseReferralMilestones(stored) ?? []) : [];
}
