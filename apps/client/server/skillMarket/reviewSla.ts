import { SkillListing, SkillListingVersion, User, type ISkillListingVersionDocument } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { Logger } from '@bike4mind/observability';
import { loadMarketSettings, notifyUser } from './market';

const logger = new Logger({ metadata: { service: 'skillMarketReviewSla' } });

const HOUR_MS = 60 * 60 * 1000;
/** Re-remind at most once per ~day even if the cron fires more often. */
const REMIND_EVERY_MS = 20 * HOUR_MS;
const BATCH = 200;
const MAX_ADMIN_RECIPIENTS = 20;
/** After this many daily nudges a stuck review stays in the queue but stops paging anyone. */
export const MAX_SLA_REMINDERS = 3;

/**
 * Daily reminder for Skill Market versions held for review past SkillMarketReviewSlaHours. Tells
 * the author it is still waiting and nudges the reviewers. It NEVER approves anything: strictness is
 * not relaxed by a timeout. Each reminder is claimed with a CAS on `reminderSentAt`, so overlapping
 * runs don't double-send, and a version gets at most MAX_SLA_REMINDERS of them.
 *
 * Runs from apps/workers/src/cron/skillMarketReviewSla.ts (hosted) and the self-host worker.
 */
export async function runSkillMarketReviewSla(now: Date = new Date()): Promise<{ reminded: number }> {
  const { reviewSlaHours } = await loadMarketSettings();
  const overdue = await SkillListingVersion.find({
    reviewStatus: 'pending',
    scanStatus: 'passed',
    createdAt: { $lt: new Date(now.getTime() - reviewSlaHours * HOUR_MS) },
    // `$not` so a version written before the counter existed still matches.
    reminderCount: { $not: { $gte: MAX_SLA_REMINDERS } },
    $or: [{ reminderSentAt: null }, { reminderSentAt: { $lt: new Date(now.getTime() - REMIND_EVERY_MS) } }],
  })
    .sort({ createdAt: 1 })
    .limit(BATCH);
  if (overdue.length === 0) return { reminded: 0 };

  let superAdmins: string[] | null = null;
  const superAdminIds = async (): Promise<string[]> =>
    (superAdmins ??= (await User.find({ isAdmin: true }).select('_id').limit(MAX_ADMIN_RECIPIENTS).lean()).map(u =>
      String(u._id)
    ));

  let reminded = 0;
  for (const version of overdue) {
    try {
      if (await remindOne(version, now, reviewSlaHours, superAdminIds)) reminded++;
    } catch (error) {
      // One bad version must not cost the rest of the batch its reminders, nor fail the run.
      logger.error(`[SKILL_MARKET] SLA reminder failed version=${String(version._id)}`, error);
    }
  }
  return { reminded };
}

/** Claim and send one version's reminder. Returns whether a reminder went out. */
async function remindOne(
  version: ISkillListingVersionDocument,
  now: Date,
  reviewSlaHours: number,
  superAdminIds: () => Promise<string[]>
): Promise<boolean> {
  const claimed = await SkillListingVersion.updateOne(
    { _id: version._id, reminderSentAt: version.reminderSentAt ?? null },
    { $set: { reminderSentAt: now }, $inc: { reminderCount: 1 } }
  );
  if (claimed.modifiedCount === 0) return false;

  const listing = await SkillListing.findById(version.listingId);
  const versionId = String(version._id);
  // Defensive: approve stamps the version before it moves the listing, so the served version
  // should never read pending - but if it does, retiring it would break imports of a live listing.
  if (listing && listing.currentApprovedVersionId === versionId) return false;
  if (!listing || listing.pendingVersionId !== versionId) {
    // Days past its verdict and still not the listing's pending pointer: an orphan from a write
    // that never landed. Nobody can decide it, so retire it.
    await SkillListingVersion.updateOne(
      { _id: version._id, reviewStatus: 'pending' },
      { $set: { reviewStatus: 'superseded' } }
    );
    return false;
  }

  let reviewers: string[];
  if (listing.visibility === 'organization' && listing.organizationId) {
    const org = await organizationRepository.findById(listing.organizationId);
    reviewers = [org?.userId, org?.managerId].filter((id): id is string => Boolean(id));
  } else {
    reviewers = await superAdminIds();
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
  return true;
}
