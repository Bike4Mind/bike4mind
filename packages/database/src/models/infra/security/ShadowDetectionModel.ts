import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  accountCampaignGroupSchema,
  accountCampaignSignals,
  accountCampaignSummary,
  withoutCampaignMember,
  SHADOW_DETECTION_ACTIONS,
  SHADOW_DETECTION_PAYMENT_KINDS,
  SHADOW_DETECTION_PAYMENT_OUTCOMES,
  type AccountCampaignGroup,
  SHADOW_DETECTION_VERDICTS,
  SHADOW_DETECTORS,
  type ShadowDetectionAction,
  type ShadowDetectionItem,
  type ShadowDetectionNetwork,
  type ShadowDetectionPayment,
  type ShadowDetectionSignal,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
  type ShadowDetectionVerdictEntry,
  type ShadowDetectionVerdictSource,
  type ShadowDetector,
  SHADOW_DETECTION_VERDICT_SOURCES,
} from '@bike4mind/common';
import { User } from '../../auth/UserModel';

/**
 * What an abuse detector would have done, recorded without acting (contract and rationale in
 * b4m-core/common/src/schemas/shadowDetection.ts). Admins grade each record; verdicts append, so a
 * correction never rewrites the history the precision numbers were taken from.
 */
export interface IShadowDetectionDocument extends Document {
  detector: ShadowDetector;
  policyVersion: number;
  wouldAction: ShadowDetectionAction;
  summary: string;
  userIds: string[];
  network: ShadowDetectionNetwork | null;
  signals: ShadowDetectionSignal[];
  windowMinutes: number | null;
  group: AccountCampaignGroup | null;
  payment: ShadowDetectionPayment | null;
  detectedAt: Date;
  verdict: ShadowDetectionVerdict | null;
  verdicts: ShadowDetectionVerdictEntry[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const RETENTION_SECONDS = 365 * 24 * 60 * 60;

const NetworkSchema = new Schema<ShadowDetectionNetwork>(
  {
    ip: { type: String, default: null },
    asn: { type: Number, default: null },
    asnOrg: { type: String, default: null },
    country: { type: String, default: null },
    hosting: { type: Boolean, default: null },
  },
  { _id: false }
);

const SignalSchema = new Schema<ShadowDetectionSignal>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    observed: { type: Number, default: null },
    threshold: { type: Number, default: null },
  },
  { _id: false }
);

const PaymentSchema = new Schema<ShadowDetectionPayment>(
  {
    paymentIntentId: { type: String, required: true },
    chargeId: { type: String, default: null },
    kind: { type: String, enum: SHADOW_DETECTION_PAYMENT_KINDS, required: true },
    outcome: { type: String, enum: SHADOW_DETECTION_PAYMENT_OUTCOMES, required: true },
    amount: { type: Number, default: null },
    currency: { type: String, default: null },
    riskLevel: { type: String, default: null },
    livemode: { type: Boolean, required: true },
  },
  { _id: false }
);

const VerdictEntrySchema = new Schema<ShadowDetectionVerdictEntry>(
  {
    verdict: { type: String, enum: SHADOW_DETECTION_VERDICTS, required: true },
    reason: { type: String, required: true },
    reviewerId: { type: String, required: true },
    reviewedAt: { type: Date, required: true },
    source: { type: String, enum: SHADOW_DETECTION_VERDICT_SOURCES },
  },
  { _id: false }
);

export const ShadowDetectionSchema = new Schema<IShadowDetectionDocument>(
  {
    detector: { type: String, enum: SHADOW_DETECTORS, required: true },
    policyVersion: { type: Number, required: true },
    wouldAction: { type: String, enum: SHADOW_DETECTION_ACTIONS, required: true },
    summary: { type: String, required: true },
    userIds: { type: [String], default: [] },
    network: { type: NetworkSchema, default: null },
    signals: { type: [SignalSchema], default: [] },
    windowMinutes: { type: Number, default: null },
    // Validated against accountCampaignGroupSchema on write (recordCampaignGroup); Mixed because the
    // nested evidence lists are read whole and never queried field by field.
    group: { type: Schema.Types.Mixed, default: null },
    payment: { type: PaymentSchema, default: null },
    detectedAt: { type: Date, required: true },
    verdict: { type: String, enum: [...SHADOW_DETECTION_VERDICTS, null], default: null },
    verdicts: { type: [VerdictEntrySchema], default: [] },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'ShadowDetection' }
);

// Retention: the record carries a raw IP, so it does not outlive a year. The unfiltered newest-first
// list ({ detectedAt: -1, _id: -1 }) gets no index of its own: volume is low, and the sort is cheap.
ShadowDetectionSchema.index({ detectedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
ShadowDetectionSchema.index({ detector: 1, verdict: 1, detectedAt: -1 });
ShadowDetectionSchema.index({ userIds: 1 });

export const ShadowDetectionModel: Model<IShadowDetectionDocument> =
  (mongoose.models.ShadowDetection as unknown as Model<IShadowDetectionDocument>) ??
  model<IShadowDetectionDocument>('ShadowDetection', ShadowDetectionSchema);

export type RecordShadowDetectionInput = Omit<ShadowDetectionItem, 'id' | 'verdict' | 'verdicts' | 'revision'>;

export type RecordCampaignGroupResult = 'created' | 'updated' | 'unchanged' | 'skipped';

/** An open campaign record stops absorbing re-observations once it has not been seen for this long. */
const CAMPAIGN_REOPEN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const directUserIds = (group: AccountCampaignGroup) =>
  group.members.filter(member => member.membership === 'direct').map(member => member.userId);

/** Recent records sharing a direct member that one sweep's group is matched against. */
const CAMPAIGN_MATCH_CANDIDATES = 20;

/**
 * The record a re-observed group continues: the one sharing the most direct members, provided they are
 * at least two and at least half of the smaller direct set. Two clusters that meet at one account, or a
 * group that drifted to new accounts, get records of their own. Candidates come newest first, so a tie
 * goes to the newest.
 */
function matchingCampaignRecord(candidates: LeanShadowDetection[], direct: string[]): LeanShadowDetection | null {
  const directSet = new Set(direct);
  let best: { record: LeanShadowDetection; overlap: number } | null = null;
  for (const record of candidates) {
    if (!record.group) continue;
    const recordDirect = directUserIds(record.group);
    const overlap = recordDirect.filter(userId => directSet.has(userId)).length;
    const continues = overlap >= 2 && overlap * 2 >= Math.min(direct.length, recordDirect.length);
    if (continues && overlap > (best?.overlap ?? 0)) best = { record, overlap };
  }
  return best?.record ?? null;
}

/** Bounds removeUser's re-read when sweeps keep rewriting the same record under it. */
const REMOVE_USER_ATTEMPTS = 3;

/**
 * The group without members whose account has been deleted since the sweep scanned it, or null once
 * too few direct members are left. Deletion purges the account from stored records, so a sweep write
 * that lands after the purge must not put it back.
 */
async function withoutDeletedMembers(group: AccountCampaignGroup): Promise<AccountCampaignGroup | null> {
  const deleted = await User.find(
    { _id: { $in: group.members.map(member => member.userId) }, deletedAt: { $ne: null } },
    { _id: 1 }
  )
    .lean<{ _id: Types.ObjectId }[]>()
    .exec();
  let live: AccountCampaignGroup | null = group;
  for (const { _id } of deleted) live = live && withoutCampaignMember(live, _id.toString());
  return live;
}

const sameMembers = (left: AccountCampaignGroup, right: AccountCampaignGroup) => {
  const key = (group: AccountCampaignGroup) =>
    group.members
      .map(member => `${member.userId}:${member.membership}`)
      .sort()
      .join();
  return key(left) === key(right);
};

export type AddShadowDetectionVerdictResult =
  | { status: 'updated'; item: ShadowDetectionItem }
  | { status: 'conflict'; item: ShadowDetectionItem }
  | { status: 'not_found' };

type LeanShadowDetection = Omit<IShadowDetectionDocument, keyof Document> & { _id: Types.ObjectId };

/**
 * Matches a record carrying a verdict graded on the Detections page. Entries from before `source`
 * existed were all such reviews.
 */
const HAS_REVIEW_VERDICT = {
  verdicts: { $elemMatch: { $or: [{ source: 'review' }, { source: { $exists: false } }] } },
};

export type AccountStatusVerdictInput = {
  userId: string;
  /** The suspend or reinstate reason, as audited. */
  reason: string;
  /** The admin who suspended or reinstated the account. */
  reviewerId: string;
};

const VERDICT_COUNT_FIELDS = {
  confirmed_abuse: 'confirmedAbuse',
  legitimate_human: 'legitimateHuman',
  legitimate_automation: 'legitimateAutomation',
  insufficient_evidence: 'insufficientEvidence',
} as const satisfies Record<ShadowDetectionVerdict, keyof ShadowDetectionSummaryRow>;

const toItem = (doc: LeanShadowDetection): ShadowDetectionItem => ({
  id: doc._id.toString(),
  detector: doc.detector,
  policyVersion: doc.policyVersion,
  wouldAction: doc.wouldAction,
  summary: doc.summary,
  userIds: doc.userIds ?? [],
  network: doc.network
    ? {
        ip: doc.network.ip ?? null,
        asn: doc.network.asn ?? null,
        asnOrg: doc.network.asnOrg ?? null,
        country: doc.network.country ?? null,
        hosting: doc.network.hosting ?? null,
      }
    : null,
  signals: (doc.signals ?? []).map(signal => ({
    key: signal.key,
    label: signal.label,
    observed: signal.observed ?? null,
    threshold: signal.threshold ?? null,
  })),
  windowMinutes: doc.windowMinutes ?? null,
  group: doc.group ?? null,
  // Records written before payment evidence existed carry no field at all.
  payment: doc.payment
    ? {
        paymentIntentId: doc.payment.paymentIntentId,
        chargeId: doc.payment.chargeId ?? null,
        kind: doc.payment.kind,
        outcome: doc.payment.outcome,
        amount: doc.payment.amount ?? null,
        currency: doc.payment.currency ?? null,
        riskLevel: doc.payment.riskLevel ?? null,
        livemode: doc.payment.livemode,
      }
    : null,
  detectedAt: doc.detectedAt,
  verdict: doc.verdict ?? null,
  verdicts: (doc.verdicts ?? []).map(entry => ({
    verdict: entry.verdict,
    reason: entry.reason,
    reviewerId: entry.reviewerId,
    reviewedAt: entry.reviewedAt,
    ...(entry.source ? { source: entry.source } : {}),
  })),
  revision: doc.revision ?? 0,
});

class ShadowDetectionRepository {
  async record(input: RecordShadowDetectionInput): Promise<string> {
    const doc = await ShadowDetectionModel.create(input);
    return doc._id.toString();
  }

  /**
   * Records one sweep's view of an account campaign group. A group re-observed while its record is
   * still ungraded updates that record in place (keeping firstObservedAt and detectedAt); the revision
   * moves only when membership changed, so a reviewer grading the old membership gets a conflict. A
   * graded record is never rewritten: the same membership just marks it seen, and new direct members
   * (including a transitive member promoted into the core) open a fresh record for a fresh review.
   */
  async recordCampaignGroup(input: RecordShadowDetectionInput): Promise<RecordCampaignGroupResult> {
    if (input.detector !== 'accountCampaign' || !input.group) {
      throw new Error('recordCampaignGroup records accountCampaign detections with group evidence only');
    }
    const scanned = accountCampaignGroupSchema.parse(input.group);
    const candidates = await ShadowDetectionModel.find({
      detector: 'accountCampaign',
      policyVersion: input.policyVersion,
      userIds: { $in: directUserIds(scanned) },
      'group.lastObservedAt': { $gte: new Date(scanned.lastObservedAt.getTime() - CAMPAIGN_REOPEN_AFTER_MS) },
    })
      .sort({ 'group.lastObservedAt': -1, _id: -1 })
      .limit(CAMPAIGN_MATCH_CANDIDATES)
      .lean<LeanShadowDetection[]>();
    // After the candidate read: a purge that lands from here on bumps the revision the update below is
    // conditional on.
    const group = await withoutDeletedMembers(scanned);
    if (!group) return 'skipped';
    const record =
      group === scanned
        ? { ...input, group }
        : {
            ...input,
            group,
            userIds: group.members.map(member => member.userId),
            summary: accountCampaignSummary(group),
            signals: accountCampaignSignals(group),
          };
    const direct = directUserIds(group);
    const existing = matchingCampaignRecord(candidates, direct);

    if (!existing?.group) {
      await ShadowDetectionModel.create(record);
      return 'created';
    }

    if (existing.verdict) {
      const reviewed = new Set(directUserIds(existing.group));
      if (direct.some(userId => !reviewed.has(userId))) {
        await ShadowDetectionModel.create(record);
        return 'created';
      }
      await ShadowDetectionModel.updateOne(
        { _id: existing._id },
        { $max: { 'group.lastObservedAt': group.lastObservedAt } }
      );
      return 'unchanged';
    }

    const membershipChanged = !sameMembers(existing.group, group);
    const updated = await ShadowDetectionModel.updateOne(
      { _id: existing._id, revision: existing.revision, verdict: null },
      {
        $set: {
          summary: record.summary,
          userIds: record.userIds,
          signals: record.signals,
          windowMinutes: record.windowMinutes,
          wouldAction: record.wouldAction,
          group: { ...group, firstObservedAt: existing.group.firstObservedAt },
        },
        ...(membershipChanged ? { $inc: { revision: 1 } } : {}),
      }
    );
    // A verdict landed between the read and the write: leave it; the next sweep sees a graded record.
    if (updated.matchedCount === 0) return 'skipped';
    return membershipChanged ? 'updated' : 'unchanged';
  }

  /**
   * Account deletion: removes the user from every detection that names them. A detection left with no
   * accounts is deleted; a campaign group is pruned with withoutCampaignMember (summary and signals
   * rebuilt, revision bumped so an open grading dialog conflicts) or deleted when fewer than three
   * direct members remain, or when its stored group no longer parses. Returns how many records were deleted.
   */
  async removeUser(userId: string): Promise<number> {
    const touched = await ShadowDetectionModel.find({ userIds: userId }).lean<LeanShadowDetection[]>();
    const deleteIds: Types.ObjectId[] = [];
    let deletedCampaigns = 0;
    for (const doc of touched) {
      if (!doc.group) {
        if ((doc.userIds ?? []).every(id => id === userId)) deleteIds.push(doc._id);
        else await ShadowDetectionModel.updateOne({ _id: doc._id }, { $pull: { userIds: userId } });
        continue;
      }
      if (await this.removeCampaignMember(doc, userId)) deletedCampaigns += 1;
    }
    if (deleteIds.length === 0) return deletedCampaigns;
    const deleted = await ShadowDetectionModel.deleteMany({ _id: { $in: deleteIds } });
    return deletedCampaigns + deleted.deletedCount;
  }

  /**
   * Prunes one campaign record, or deletes it; true when it was deleted. Each write is conditional on
   * the revision it was computed from, so a sweep rewrite in between is re-read and pruned again.
   */
  private async removeCampaignMember(doc: LeanShadowDetection, userId: string): Promise<boolean> {
    let current: LeanShadowDetection | null = doc;
    for (let attempt = 0; attempt < REMOVE_USER_ATTEMPTS; attempt++) {
      if (!current?.userIds.includes(userId)) return false;
      const parsed = accountCampaignGroupSchema.safeParse(current.group);
      const pruned = parsed.success ? withoutCampaignMember(parsed.data, userId) : null;
      const filter = { _id: current._id, revision: current.revision };
      if (!pruned) {
        const { deletedCount } = await ShadowDetectionModel.deleteOne(filter);
        if (deletedCount === 1) return true;
      } else {
        const { matchedCount } = await ShadowDetectionModel.updateOne(filter, {
          $set: {
            group: pruned,
            userIds: pruned.members.map(member => member.userId),
            summary: accountCampaignSummary(pruned),
            signals: accountCampaignSignals(pruned),
          },
          $inc: { revision: 1 },
        });
        if (matchedCount === 1) return false;
      }
      current = await ShadowDetectionModel.findById(doc._id).lean<LeanShadowDetection>();
    }
    throw new Error(`Shadow detection ${doc._id.toString()} kept changing while removing a deleted user`);
  }

  /** Detections naming this user that no reviewer has judged legitimate (unreviewed included). */
  async countOpenForUser(userId: string): Promise<number> {
    return ShadowDetectionModel.countDocuments({
      userIds: userId,
      verdict: { $nin: ['legitimate_human', 'legitimate_automation'] },
    }).exec();
  }

  /** Newest first; `truncated` is true when more than `limit` records match. */
  async list(query: {
    detector?: ShadowDetector;
    verdict?: ShadowDetectionVerdict | 'unreviewed';
    limit: number;
  }): Promise<{ data: ShadowDetectionItem[]; truncated: boolean }> {
    const filter: Record<string, unknown> = {};
    if (query.detector) filter.detector = query.detector;
    if (query.verdict) filter.verdict = query.verdict === 'unreviewed' ? null : query.verdict;
    const docs = await ShadowDetectionModel.find(filter)
      .sort({ detectedAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<LeanShadowDetection[]>();
    return { data: docs.slice(0, query.limit).map(toItem), truncated: docs.length > query.limit };
  }

  async findById(id: string): Promise<ShadowDetectionItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await ShadowDetectionModel.findById(id).lean<LeanShadowDetection>();
    return doc ? toItem(doc) : null;
  }

  /**
   * Ungraded detections recorded at or after `since`, newest first. `excludeDetectors` filters in
   * the query, so excluded detectors never take a slot from the `limit`.
   */
  async listUnreviewedSince(
    since: Date,
    limit: number,
    options: { excludeDetectors?: readonly ShadowDetector[] } = {}
  ): Promise<ShadowDetectionItem[]> {
    const filter: Record<string, unknown> = { verdict: null, detectedAt: { $gte: since } };
    if (options.excludeDetectors?.length) filter.detector = { $nin: [...options.excludeDetectors] };
    const docs = await ShadowDetectionModel.find(filter)
      .sort({ detectedAt: -1, _id: -1 })
      .limit(limit)
      .lean<LeanShadowDetection[]>();
    return docs.map(toItem);
  }

  /**
   * Appends a verdict when the record is still at `expectedRevision`, in one atomic update, so two
   * reviewers grading the same record cannot overwrite each other: the loser gets the current record
   * back as a conflict.
   */
  async addVerdict(input: {
    id: string;
    expectedRevision: number;
    verdict: ShadowDetectionVerdict;
    reason: string;
    reviewerId: string;
  }): Promise<AddShadowDetectionVerdictResult> {
    if (!Types.ObjectId.isValid(input.id)) return { status: 'not_found' };
    const entry: ShadowDetectionVerdictEntry = {
      verdict: input.verdict,
      reason: input.reason,
      reviewerId: input.reviewerId,
      reviewedAt: new Date(),
      source: 'review',
    };
    const updated = await ShadowDetectionModel.findOneAndUpdate(
      { _id: input.id, revision: input.expectedRevision },
      { $push: { verdicts: entry }, $set: { verdict: input.verdict }, $inc: { revision: 1 } },
      { new: true }
    ).lean<LeanShadowDetection>();
    if (updated) return { status: 'updated', item: toItem(updated) };

    const current = await ShadowDetectionModel.findById(input.id).lean<LeanShadowDetection>();
    return current ? { status: 'conflict', item: toItem(current) } : { status: 'not_found' };
  }

  /**
   * An admin suspended the account for abuse: every ungraded detection naming it is graded
   * confirmed_abuse. Graded records are left alone. Returns the records it graded.
   */
  async gradeForSuspension(input: AccountStatusVerdictInput): Promise<ShadowDetectionItem[]> {
    const candidates = await ShadowDetectionModel.find({ userIds: input.userId, verdict: null }).lean<
      LeanShadowDetection[]
    >();
    return this.appendStatusVerdicts(candidates, { verdict: null }, 'confirmed_abuse', 'suspension', input);
  }

  /**
   * An admin reinstated the account: detections naming it are graded legitimate_human, replacing an
   * ungraded state or a verdict recorded by a suspension. Skipped when a reviewer graded the record on
   * the Detections page, when it already reads legitimate_human, or when it names another account that
   * is still suspended (one reinstated member does not clear a burst). Returns the records it graded.
   */
  async gradeForReinstatement(input: AccountStatusVerdictInput): Promise<ShadowDetectionItem[]> {
    const open = { verdict: { $ne: 'legitimate_human' }, $nor: [HAS_REVIEW_VERDICT] };
    const candidates = await ShadowDetectionModel.find({ userIds: input.userId, ...open }).lean<
      LeanShadowDetection[]
    >();
    const peerIds = [...new Set(candidates.flatMap(doc => doc.userIds ?? []).filter(id => id !== input.userId))].filter(
      id => Types.ObjectId.isValid(id)
    );
    const suspendedPeers = new Set(
      peerIds.length === 0
        ? []
        : (
            await User.find({ _id: { $in: peerIds }, isBanned: true }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()
          ).map(({ _id }) => _id.toString())
    );
    const eligible = candidates.filter(doc => !(doc.userIds ?? []).some(id => suspendedPeers.has(id)));
    return this.appendStatusVerdicts(eligible, open, 'legitimate_human', 'reinstatement', input);
  }

  /**
   * Appends one verdict per record, each conditional on the revision it was read at and on `stillOpen`,
   * so a reviewer grading the same record in between keeps their verdict.
   */
  private async appendStatusVerdicts(
    candidates: LeanShadowDetection[],
    stillOpen: Record<string, unknown>,
    verdict: ShadowDetectionVerdict,
    source: ShadowDetectionVerdictSource,
    input: AccountStatusVerdictInput
  ): Promise<ShadowDetectionItem[]> {
    const graded: ShadowDetectionItem[] = [];
    for (const doc of candidates) {
      const entry: ShadowDetectionVerdictEntry = {
        verdict,
        reason: input.reason,
        reviewerId: input.reviewerId,
        reviewedAt: new Date(),
        source,
      };
      const updated = await ShadowDetectionModel.findOneAndUpdate(
        { _id: doc._id, revision: doc.revision, ...stillOpen },
        { $push: { verdicts: entry }, $set: { verdict }, $inc: { revision: 1 } },
        { new: true }
      ).lean<LeanShadowDetection>();
      if (updated) graded.push(toItem(updated));
    }
    return graded;
  }

  /**
   * Counts per detector and policy version; verdict counts are on each record's latest verdict and
   * only for records that would have acted. A `wouldAction: 'none'` record counts in `recorded` and
   * `noAction` only, so agreeing with it never moves precision.
   */
  async summarize(): Promise<ShadowDetectionSummaryRow[]> {
    const rows = await ShadowDetectionModel.aggregate<{
      _id: {
        detector: ShadowDetector;
        policyVersion: number;
        verdict: ShadowDetectionVerdict | null;
        noAction: boolean;
      };
      count: number;
    }>([
      {
        $group: {
          _id: {
            detector: '$detector',
            policyVersion: '$policyVersion',
            verdict: { $ifNull: ['$verdict', null] },
            noAction: { $eq: ['$wouldAction', 'none'] },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const byPolicy = new Map<string, ShadowDetectionSummaryRow>();
    for (const { _id, count } of rows) {
      const key = `${_id.detector}:${_id.policyVersion}`;
      const row = byPolicy.get(key) ?? {
        detector: _id.detector,
        policyVersion: _id.policyVersion,
        recorded: 0,
        noAction: 0,
        confirmedAbuse: 0,
        legitimateHuman: 0,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      };
      row.recorded += count;
      if (_id.noAction) row.noAction += count;
      else if (_id.verdict) row[VERDICT_COUNT_FIELDS[_id.verdict]] += count;
      byPolicy.set(key, row);
    }
    return [...byPolicy.values()].sort(
      (left, right) => left.detector.localeCompare(right.detector) || right.policyVersion - left.policyVersion
    );
  }
}

export const shadowDetectionRepository = new ShadowDetectionRepository();
