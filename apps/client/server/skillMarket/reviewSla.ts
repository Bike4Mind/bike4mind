import { SkillListing, SkillListingVersion, User } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { loadMarketSettings, notifyUser } from './market';

const HOUR_MS = 60 * 60 * 1000;
/** Re-remind at most once per ~day even if the cron fires more often. */
const REMIND_EVERY_MS = 20 * HOUR_MS;
const BATCH = 200;
const MAX_ADMIN_RECIPIENTS = 20;

/**
 * Daily reminder for Skill Market versions held for review past SkillMarketReviewSlaHours. Tells
 * the author it is still waiting and nudges the reviewers. It NEVER approves anything: strictness is
 * not relaxed by a timeout. Each reminder is claimed with a CAS on `reminderSentAt`, so overlapping
 * runs don't double-send.
 *
 * Runs from apps/workers/src/cron/skillMarketReviewSla.ts (hosted) and the self-host worker.
 */
export async function runSkillMarketReviewSla(now: Date = new Date()): Promise<{ reminded: number }> {
  const { reviewSlaHours } = await loadMarketSettings();
  const overdue = await SkillListingVersion.find({
    reviewStatus: 'pending',
    scanStatus: 'passed',
    createdAt: { $lt: new Date(now.getTime() - reviewSlaHours * HOUR_MS) },
    $or: [{ reminderSentAt: null }, { reminderSentAt: { $lt: new Date(now.getTime() - REMIND_EVERY_MS) } }],
  })
    .sort({ createdAt: 1 })
    .limit(BATCH);
  if (overdue.length === 0) return { reminded: 0 };

  let superAdmins: string[] | null = null;
  let reminded = 0;
  for (const version of overdue) {
    const claimed = await SkillListingVersion.updateOne(
      { _id: version._id, reminderSentAt: version.reminderSentAt ?? null },
      { $set: { reminderSentAt: now } }
    );
    if (claimed.modifiedCount === 0) continue;

    const listing = await SkillListing.findById(version.listingId);
    const versionId = String(version._id);
    if (listing && listing.currentApprovedVersionId === versionId) {
      // A crash between the approve CAS and the version stamp left the live version marked pending.
      // It is not an orphan and must never be retired; a new submission by the author repairs it.
      continue;
    }
    if (!listing || listing.pendingVersionId !== versionId) {
      // Days past its verdict and still not the listing's pending pointer: an orphan from a write
      // that never landed. Nobody can decide it, so retire it.
      await SkillListingVersion.updateOne(
        { _id: version._id, reviewStatus: 'pending' },
        { $set: { reviewStatus: 'superseded' } }
      );
      continue;
    }

    let reviewers: string[];
    if (listing.visibility === 'organization' && listing.organizationId) {
      const org = await organizationRepository.findById(listing.organizationId);
      reviewers = [org?.userId, org?.managerId].filter((id): id is string => Boolean(id));
    } else {
      superAdmins ??= (await User.find({ isAdmin: true }).select('_id').limit(MAX_ADMIN_RECIPIENTS).lean()).map(u =>
        String(u._id)
      );
      reviewers = superAdmins;
    }

    const name = `/${version.snapshot.name} v${version.version}`;
    await notifyUser(
      listing.authorUserId,
      `${name} is still waiting for review`,
      'A reviewer has not decided yet. It stays unpublished until a human approves it; any earlier live version is unaffected.'
    );
    for (const reviewerId of new Set(reviewers)) {
      if (reviewerId === listing.authorUserId) continue;
      await notifyUser(
        reviewerId,
        `Skill Market review overdue: ${name}`,
        `It has waited more than ${reviewSlaHours} hours. Open Skills > Market > Review queue to approve or reject it.`
      );
    }
    reminded++;
  }
  return { reminded };
}
