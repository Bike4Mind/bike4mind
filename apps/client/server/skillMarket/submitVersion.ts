import mongoose from 'mongoose';
import {
  SkillListing,
  SkillListingVersion,
  approvePendingListingVersion,
  claimSkillVersionScan,
  clearPendingListingVersion,
  setPendingListingVersion,
  writeSkillVersionScanVerdict,
  type ISkillListingVersionDocument,
  type SkillListingDenorm,
} from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ISkill,
  type ISkillListing,
  type ISkillListingVersion,
  type ISkillScanFinding,
} from '@bike4mind/common';
import { computeTier, reviewStatusFor, runDeterministicScan, scanPublicText } from './scanRules';
import type { ClassifierLlm, ClassifierResult } from './classifySkill';
import { classifySkill } from './classifySkill';
import {
  canReviewListing,
  loadMarketSettings,
  notifyUser,
  skillContentHash,
  toSnapshot,
  type MarketActor,
  type MarketSettings,
} from './market';

/**
 * Submit -> scan -> decide, for both a new listing's first version and every resubmit. The scan
 * runs inline so a clean listing is live within seconds; the claim stamp written at creation
 * (`scanClaimedAt`) guards the verdict, and `rescanVersion` re-claims an errored or abandoned scan.
 */

export type ScanDeps = {
  /** Resolves the classifier model lazily, so a deterministic fail costs no LLM call. */
  getClassifier: () => Promise<ClassifierLlm>;
  settings?: MarketSettings;
  random?: () => number;
};

const plainVersion = (doc: ISkillListingVersionDocument): ISkillListingVersion =>
  doc.toJSON() as unknown as ISkillListingVersion;

/** A different author already sells this exact content: blocks clone/copycat spam. */
async function duplicateFinding(listing: ISkillListing, contentHash: string): Promise<ISkillScanFinding | null> {
  // Only a version that actually passed (and is still live or waiting) is a real duplicate; a
  // failed copy that never published must not block the original author from re-publishing.
  const sameContent = await SkillListingVersion.find({
    contentHash,
    listingId: { $ne: String(listing.id) },
    scanStatus: 'passed',
    reviewStatus: { $in: ['pending', 'approved', 'auto_approved'] },
  })
    .select('listingId')
    .limit(50)
    .lean();
  if (sameContent.length === 0) return null;
  const clash = await SkillListing.exists({
    _id: { $in: sameContent.map(v => v.listingId) },
    authorUserId: { $ne: listing.authorUserId },
    status: { $nin: ['withdrawn', 'rejected'] },
    deletedAt: null,
  });
  return clash
    ? {
        rule: 'duplicate_listing',
        severity: 'critical',
        message: 'Identical content is already published by another author',
        source: 'rules',
      }
    : null;
}

export async function submitListingVersion(
  listing: ISkillListing,
  skill: ISkill,
  deps: ScanDeps
): Promise<ISkillListingVersion> {
  const snapshot = toSnapshot(skill);
  const contentHash = skillContentHash(skill);

  const unchanged = await SkillListingVersion.exists({
    listingId: String(listing.id),
    contentHash,
    'snapshot.name': snapshot.name,
    // Only content that is live or already waiting is "unchanged"; an older approved version the
    // author reverted to is a legitimate new submission, not a no-op.
    $or: [
      { reviewStatus: 'pending' },
      ...(listing.currentApprovedVersionId ? [{ _id: listing.currentApprovedVersionId }] : []),
    ],
  });
  if (unchanged) throw new BadRequestError('This exact content is already live or waiting for review');

  const counter = await SkillListing.findOneAndUpdate(
    { _id: listing.id, status: { $nin: ['delisted', 'withdrawn'] }, deletedAt: null },
    { $inc: { latestVersion: 1 } },
    { new: true }
  );
  if (!counter) throw new ConflictError('This listing no longer accepts new versions');

  const claimedAt = new Date();
  const created = await SkillListingVersion.create({
    listingId: String(listing.id),
    version: counter.latestVersion,
    snapshot,
    contentHash,
    scanStatus: 'scanning',
    scanClaimedAt: claimedAt,
    reviewStatus: 'not_required',
  });

  return scanAndDecide(listing, plainVersion(created), claimedAt, deps);
}

/** Author retry of an `error` scan, or of a `scanning` claim whose request died (older than 5 min). */
export async function rescanVersion(
  listing: ISkillListing,
  versionId: string,
  deps: ScanDeps
): Promise<ISkillListingVersion> {
  const claimedAt = new Date();
  const claimed = await claimSkillVersionScan(versionId, claimedAt, new Date(Date.now() - 5 * 60_000));
  if (!claimed) throw new ConflictError('This version is not waiting for a rescan');
  return scanAndDecide(listing, plainVersion(claimed), claimedAt, deps);
}

async function scanAndDecide(
  listing: ISkillListing,
  version: ISkillListingVersion,
  claimedAt: Date,
  deps: ScanDeps
): Promise<ISkillListingVersion> {
  const settings = deps.settings ?? (await loadMarketSettings());
  const listingId = String(listing.id);
  const versionId = String(version.id);

  const findings = runDeterministicScan(version.snapshot, {
    highRiskTools: settings.highRiskTools,
    urlAllowlist: settings.urlAllowlist,
  });
  const duplicate = await duplicateFinding(listing, version.contentHash);
  if (duplicate) findings.push(duplicate);

  // Deterministic critical findings fail the version outright; the classifier can't overturn them.
  let classifier: ClassifierResult | null = null;
  if (!findings.some(f => f.severity === 'critical')) {
    try {
      classifier = await classifySkill(version.snapshot, await deps.getClassifier());
    } catch (error) {
      classifier = {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 300) : 'Classifier unavailable',
      };
    }
  }

  if (classifier && !classifier.ok) {
    // Fail closed: an unscanned version is never publishable. The author can rescan.
    await writeSkillVersionScanVerdict(versionId, claimedAt, {
      scanStatus: 'error',
      scanFindings: findings,
      scanError: classifier.error,
      scanModel: classifier.model,
      reviewStatus: 'not_required',
    });
    await notifyUser(
      listing.authorUserId,
      `Safety scan could not finish for /${version.snapshot.name}`,
      'The automated safety scan hit an error, so nothing was published. Open My listings to retry the scan.'
    );
    return reload(versionId);
  }

  // The honest summary is model output an adversarial body can steer, and every field of it is
  // shown to viewers, so the whole summary is scanned - not just the prose fields.
  const summaryFindings = classifier?.ok
    ? scanPublicText(
        [
          classifier.honestSummary.whatItDoes,
          classifier.honestSummary.dataItTouches,
          ...classifier.honestSummary.riskNotes,
          classifier.honestSummary.mismatchNote ?? '',
          ...classifier.honestSummary.toolsUsed,
        ].join('\n'),
        settings.urlAllowlist
      ).map(f => ({ ...f, rule: `summary_${f.rule}`, severity: 'high' as const, message: `AI summary: ${f.message}` }))
    : [];
  const allFindings = classifier?.ok ? [...findings, ...classifier.findings, ...summaryFindings] : findings;
  const tier = classifier?.ok
    ? computeTier(
        allFindings,
        {
          verdict: classifier.verdict,
          confidence: classifier.confidence,
          descriptionMatches: classifier.honestSummary.descriptionMatches,
        },
        settings.minConfidence
      )
    : 'failed';

  if (tier === 'failed') {
    const landed = await writeSkillVersionScanVerdict(versionId, claimedAt, {
      scanStatus: 'failed',
      scanFindings: allFindings,
      ...(classifier?.ok ? { honestSummary: classifier.honestSummary, scanModel: classifier.model } : {}),
      reviewStatus: 'not_required',
    });
    if (landed) {
      await SkillListing.updateOne(
        { _id: listingId, currentApprovedVersionId: null, pendingVersionId: null, status: 'in_review' },
        { $set: { status: 'rejected' } }
      );
      await notifyUser(
        listing.authorUserId,
        `/${version.snapshot.name} did not pass the safety scan`,
        'Your submission was not published. Open My listings to see what the scan found, fix the skill and resubmit.'
      );
    }
    return reload(versionId);
  }

  const reviewStatus = reviewStatusFor(tier, listing.visibility);
  const auto = reviewStatus === 'auto_approved';
  const landed = await writeSkillVersionScanVerdict(versionId, claimedAt, {
    scanStatus: 'passed',
    scanFindings: allFindings,
    riskTier: tier,
    ...(classifier?.ok ? { honestSummary: classifier.honestSummary, scanModel: classifier.model } : {}),
    reviewStatus,
    ...(auto ? { auditSample: (deps.random ?? Math.random)() < settings.auditSampleRate } : {}),
  });
  if (!landed) return reload(versionId);

  const pending = await setPendingListingVersion(listingId, versionId, version.version);
  if (pending === false) {
    await SkillListingVersion.updateOne({ _id: versionId }, { $set: { reviewStatus: 'superseded' } });
    return reload(versionId);
  }
  if (pending.displacedVersionId) {
    await SkillListingVersion.updateOne(
      { _id: pending.displacedVersionId, reviewStatus: 'pending' },
      { $set: { reviewStatus: 'superseded' } }
    );
  }

  const fresh = await reload(versionId);
  if (auto) {
    // A newer version can take `pendingVersionId` between the two writes; then this one is superseded.
    if (!(await approvePendingListingVersion(listingId, versionId, version.version, denormFor(fresh, true)))) {
      await SkillListingVersion.updateOne({ _id: versionId }, { $set: { reviewStatus: 'superseded' } });
      return reload(versionId);
    }
    await notifyUser(
      listing.authorUserId,
      `/${version.snapshot.name} v${version.version} is live`,
      'It passed the automated safety scan and is now on the Skill Market.'
    );
  } else {
    await notifyUser(
      listing.authorUserId,
      `/${version.snapshot.name} v${version.version} is waiting for review`,
      'It passed the automated scan but needs a human reviewer before it goes live. Any earlier live version stays available meanwhile.'
    );
  }
  return reload(versionId);
}

async function reload(versionId: string): Promise<ISkillListingVersion> {
  const doc = await SkillListingVersion.findById(versionId);
  if (!doc) throw new NotFoundError('Version not found');
  return plainVersion(doc);
}

export function denormFor(version: ISkillListingVersion, autoChecked: boolean): SkillListingDenorm {
  return {
    name: version.snapshot.name,
    description: version.snapshot.description,
    honestSummaryText: version.honestSummary?.whatItDoes,
    descriptionMatches: version.honestSummary?.descriptionMatches ?? true,
    usesTools: (version.snapshot.allowedTools?.length ?? 0) > 0,
    riskTier: version.riskTier,
    autoChecked,
  };
}

export type ReviewDecision =
  | { action: 'approve'; ackHighRisk?: boolean; ackMismatch?: boolean; note?: string }
  | { action: 'reject'; note: string };

/**
 * A human decision on a held version. Approve is a CAS on the listing's `pendingVersionId`; only
 * the winner stamps the version, so a stale approve of a superseded version answers 409.
 */
export async function decideVersion(
  versionId: string,
  actor: MarketActor,
  adminOrgIds: string[],
  decision: ReviewDecision
): Promise<ISkillListingVersion> {
  const versionDoc = mongoose.isObjectIdOrHexString(versionId) ? await SkillListingVersion.findById(versionId) : null;
  if (!versionDoc) throw new NotFoundError('Version not found');
  const version = plainVersion(versionDoc);
  const listingDoc = await SkillListing.findById(version.listingId);
  if (!listingDoc) throw new NotFoundError('Listing not found');
  const listing = listingDoc.toJSON() as unknown as ISkillListing;

  if (!canReviewListing(listing, actor, adminOrgIds)) {
    throw new ForbiddenError(
      listing.authorUserId === actor.id && listing.visibility === 'public'
        ? 'You cannot review your own Public listing'
        : "You don't have permission to review this listing"
    );
  }
  if (version.reviewStatus !== 'pending') throw new ConflictError('This version is no longer waiting for review');

  const now = new Date();
  if (decision.action === 'approve') {
    if (listing.visibility === 'public') {
      if (version.riskTier === 'high' && !decision.ackHighRisk) {
        throw new BadRequestError('Acknowledge the high-risk findings before approving a Public listing');
      }
      if (version.honestSummary?.descriptionMatches === false && !decision.ackMismatch) {
        throw new BadRequestError('Acknowledge the description mismatch before approving a Public listing');
      }
    }
    // Stamp the version before publishing it, so a crash can never leave the listing pointing at a
    // version that is still `pending` (imports and detail read the version's own review state).
    // If the publish CAS then loses, roll the stamp back so the version is not left marked approved.
    const stamped = await SkillListingVersion.updateOne(
      { _id: versionId, reviewStatus: 'pending' },
      {
        $set: {
          reviewStatus: 'approved',
          reviewerUserId: actor.id,
          reviewedAt: now,
          reviewAckHighRisk: Boolean(decision.ackHighRisk),
          reviewAckMismatch: Boolean(decision.ackMismatch),
          ...(decision.note ? { reviewNote: decision.note } : {}),
          // An org admin may approve their own Organization listing so sharing isn't blocked, but a
          // compromised admin must not publish unseen: every self-approval lands in the audit queue.
          ...(listing.authorUserId === actor.id ? { auditSample: true, auditedAt: null } : {}),
        },
      }
    );
    if (stamped.modifiedCount === 0) throw new ConflictError('This version was superseded or already decided');
    const won = await approvePendingListingVersion(
      String(listing.id),
      versionId,
      version.version,
      denormFor(version, false)
    );
    if (!won) {
      await SkillListingVersion.updateOne(
        { _id: versionId, reviewStatus: 'approved', reviewedAt: now },
        {
          $set: { reviewStatus: 'pending' },
          $unset: {
            reviewerUserId: 1,
            reviewedAt: 1,
            reviewAckHighRisk: 1,
            reviewAckMismatch: 1,
            reviewNote: 1,
            auditSample: 1,
            auditedAt: 1,
          },
        }
      );
      throw new ConflictError('This version was superseded or already decided');
    }
    await notifyUser(
      listing.authorUserId,
      `/${version.snapshot.name} v${version.version} was approved`,
      'A reviewer approved your skill and it is now live on the Skill Market.'
    );
  } else {
    const won = await clearPendingListingVersion(String(listing.id), versionId);
    if (!won) throw new ConflictError('This version was superseded or already decided');
    await SkillListingVersion.updateOne(
      { _id: versionId, reviewStatus: 'pending' },
      { $set: { reviewStatus: 'rejected', reviewerUserId: actor.id, reviewedAt: now, reviewNote: decision.note } }
    );
    await notifyUser(
      listing.authorUserId,
      `/${version.snapshot.name} v${version.version} was not approved`,
      `Reviewer note: ${decision.note}`
    );
  }
  return reload(versionId);
}
