import mongoose, { Schema, type FilterQuery } from 'mongoose';
import type {
  SignupDomainHoldAssessment,
  SignupDomainHoldAutoPolicy,
  SignupDomainHoldReasonFilter,
  SignupDomainHoldStatusFilter,
  SignupDomainReview,
  SignupObservation,
  SignupProtectionRepository,
} from '@bike4mind/common';
import {
  emailDomainCandidates,
  SIGNUP_DOMAIN_HOLD_ASSESSMENT_FAILURES,
  SIGNUP_DOMAIN_HOLD_AUTO_POLICIES,
  SIGNUP_DOMAIN_HOLD_JUDGMENTS,
  SIGNUP_DOMAIN_HOLD_REASON_FILTERS,
  SIGNUP_DOMAIN_HOLD_STATUS_FILTERS,
  YOUNG_DOMAIN_HOLD_REASON_PREFIX,
} from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { PartnerSignupRule } from './PartnerSignupRuleModel';
import { disposableDomainRepository } from './DisposableDomainModel';

const observationSchema = new Schema<SignupObservation>({
  userId: { type: String, required: true, unique: true },
  email: { type: String, required: true },
  domain: { type: String, required: true },
  verifiedAt: { type: Date, required: true },
});
observationSchema.index({ domain: 1, verifiedAt: -1 });
observationSchema.index({ verifiedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const reviewSchema = new Schema<SignupDomainReview>({
  domain: { type: String, required: true, unique: true },
  status: { type: String, enum: ['held_pending_review', 'blocked', 'released'], required: true },
  reason: { type: String, required: true },
  triggeredAt: { type: Date, required: true },
  cohortUserIds: { type: [String], default: [] },
  sampleEmails: { type: [String], default: [] },
  signupCount: { type: Number, required: true },
  reviewedBy: String,
  reviewedAt: Date,
  autoDecision: {
    type: new Schema(
      {
        policy: { type: String, enum: SIGNUP_DOMAIN_HOLD_AUTO_POLICIES, required: true },
        decidedAt: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: undefined,
  },
  // Flat storage for the discriminated union signupDomainHoldAssessmentSchema (common); `outcome`
  // says which of the optional fields are set.
  assessment: {
    type: new Schema(
      {
        outcome: { type: String, enum: ['judged', 'failed'], required: true },
        policyVersion: { type: Number, required: true },
        judgment: { type: String, enum: SIGNUP_DOMAIN_HOLD_JUDGMENTS },
        confidence: Number,
        failure: { type: String, enum: SIGNUP_DOMAIN_HOLD_ASSESSMENT_FAILURES },
        attempts: Number,
        model: { type: String, required: true },
        assessedAt: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: undefined,
  },
  domainRegisteredAt: Date,
  domainAgeCheckedAt: Date,
  domainAgedAt: Date,
});
reviewSchema.index({ triggeredAt: -1 });
reviewSchema.index({ status: 1, reason: 1, triggeredAt: 1 });

export const SignupObservationModel: mongoose.Model<SignupObservation> =
  (mongoose.models.SignupObservation as mongoose.Model<SignupObservation>) ??
  mongoose.model('SignupObservation', observationSchema);
export const SignupDomainReviewModel: mongoose.Model<SignupDomainReview> =
  (mongoose.models.SignupDomainReview as mongoose.Model<SignupDomainReview>) ??
  mongoose.model('SignupDomainReview', reviewSchema);

const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

export const signupProtectionRepository: SignupProtectionRepository = {
  async observe(signup) {
    try {
      await SignupObservationModel.updateOne({ userId: signup.userId }, { $setOnInsert: signup }, { upsert: true });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
  },
  async recent(domain, since) {
    return SignupObservationModel.find({ domain, verifiedAt: { $gte: since } })
      .sort({ verifiedAt: -1, userId: -1 })
      .limit(1000)
      .lean();
  },
  async findReview(domain) {
    return SignupDomainReviewModel.findOne({ domain }).lean();
  },
  async createHold(review) {
    try {
      const result = await SignupDomainReviewModel.updateOne(
        { domain: review.domain },
        { $setOnInsert: review },
        { upsert: true }
      );
      return result.upsertedCount === 1;
    } catch (error) {
      if (isDuplicate(error)) return false;
      throw error;
    }
  },
  async isOrganizationDomain(email) {
    return !!(await PartnerSignupRule.exists({
      domain: { $in: emailDomainCandidates(email) },
      enabled: true,
      organizationId: { $type: 'string', $ne: '' },
    }));
  },
  disposableSources: disposableDomainRepository.disposableSources,
  findDomainIntel: disposableDomainRepository.findDomainIntel,
  saveDomainIntel: disposableDomainRepository.saveDomainIntel,
};

export type SignupDomainHoldListFilter = {
  status: SignupDomainHoldStatusFilter;
  reason?: SignupDomainHoldReasonFilter;
  /** Settled (blocked/released) holds decided before this are left out; absent includes them all. */
  settledSince?: Date;
};

const prefixRegex = (prefix: string) => ({ $regex: `^${escapeRegex(prefix)}` });

/**
 * A pending hold always shows: it still needs a decision. A settled one is only hidden, never
 * deleted, since a released row keeps its domain exempt and a blocked row keeps withholding credits.
 */
const holdListQuery = ({
  status,
  reason,
  settledSince,
}: SignupDomainHoldListFilter): FilterQuery<SignupDomainReview> => {
  const reasonQuery = reason ? { reason: prefixRegex(SIGNUP_DOMAIN_HOLD_REASON_FILTERS[reason]) } : {};
  const decidedRecently = settledSince
    ? {
        $or: [
          { reviewedAt: { $gte: settledSince } },
          { reviewedAt: { $exists: false }, triggeredAt: { $gte: settledSince } },
        ],
      }
    : {};
  switch (status) {
    case 'pending':
      return { status: 'held_pending_review', ...reasonQuery };
    case 'blocked':
    case 'released':
      return { status, ...reasonQuery, ...decidedRecently };
    case 'all':
      return settledSince
        ? {
            ...reasonQuery,
            $or: [{ status: 'held_pending_review' }, { status: { $in: ['blocked', 'released'] }, ...decidedRecently }],
          }
        : reasonQuery;
  }
};

/** The admin Signup Domain Holds list (apps/client/pages/api/admin/signup-domain-holds.ts). */
export const signupDomainHoldListRepository = {
  /** Newest first. */
  async list(filter: SignupDomainHoldListFilter, page: number, limit: number): Promise<SignupDomainReview[]> {
    return SignupDomainReviewModel.find(holdListQuery(filter))
      .sort({ triggeredAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  },
  /** Rows per status view under the same reason filter and visibility window. */
  async countByStatus(
    filter: Omit<SignupDomainHoldListFilter, 'status'>
  ): Promise<Record<SignupDomainHoldStatusFilter, number>> {
    const counts = await Promise.all(
      SIGNUP_DOMAIN_HOLD_STATUS_FILTERS.map(status =>
        SignupDomainReviewModel.countDocuments(holdListQuery({ ...filter, status }))
      )
    );
    return Object.fromEntries(
      SIGNUP_DOMAIN_HOLD_STATUS_FILTERS.map((status, index) => [status, counts[index]])
    ) as Record<SignupDomainHoldStatusFilter, number>;
  },
};

/** Queue operations for the automated hold triage (apps/workers/src/cron/signupDomainHoldTriage.ts). */
export const signupDomainReviewRepository = {
  /** Oldest first, so a backlog drains in order across runs. */
  async listPending(reason: string, limit: number): Promise<SignupDomainReview[]> {
    return SignupDomainReviewModel.find({ status: 'held_pending_review', reason })
      .sort({ triggeredAt: 1, _id: 1 })
      .limit(limit)
      .lean();
  },
  /**
   * Moves a still-pending hold to `blocked` on behalf of an automated policy. False when an admin
   * (or another run) decided it first, so a concurrent admin decision always wins.
   */
  async autoConfirm(
    domain: string,
    reason: string,
    policy: SignupDomainHoldAutoPolicy,
    decidedAt: Date
  ): Promise<boolean> {
    const result = await SignupDomainReviewModel.updateOne(
      { domain, reason, status: 'held_pending_review' },
      {
        $set: { status: 'blocked', reviewedAt: decidedAt, autoDecision: { policy, decidedAt } },
        $unset: { reviewedBy: 1 },
      }
    );
    return result.modifiedCount === 1;
  },
  /**
   * Pending holds whose reason starts with `reasonPrefix` and that need an advisory assessment: never
   * assessed, assessed under another policy version, or failed fewer than `maxAttempts` times with
   * the last attempt at or before `retryBefore`. Oldest first.
   */
  async listPendingForAssessment(
    reasonPrefix: string,
    { policyVersion, maxAttempts, retryBefore }: { policyVersion: number; maxAttempts: number; retryBefore: Date },
    limit: number
  ): Promise<SignupDomainReview[]> {
    return SignupDomainReviewModel.find({
      status: 'held_pending_review',
      reason: { $regex: `^${escapeRegex(reasonPrefix)}` },
      $or: [
        { assessment: { $exists: false } },
        { 'assessment.policyVersion': { $ne: policyVersion } },
        {
          'assessment.outcome': 'failed',
          'assessment.attempts': { $lt: maxAttempts },
          'assessment.assessedAt': { $lte: retryBefore },
        },
      ],
    })
      .sort({ triggeredAt: 1, _id: 1 })
      .limit(limit)
      .lean();
  },
  /** Stores an advisory verdict on a still-pending hold. False when the hold was decided first. */
  async recordAssessment(domain: string, assessment: SignupDomainHoldAssessment): Promise<boolean> {
    const result = await SignupDomainReviewModel.updateOne(
      { domain, status: 'held_pending_review' },
      { $set: { assessment } }
    );
    return result.modifiedCount === 1;
  },
  /**
   * Pending young-domain holds the age recheck has no registration date for yet, never looked up or
   * last looked up at or before `retryBefore`. Oldest first.
   */
  async listForAgeRecheck(retryBefore: Date, limit: number): Promise<SignupDomainReview[]> {
    return SignupDomainReviewModel.find({
      status: 'held_pending_review',
      reason: prefixRegex(YOUNG_DOMAIN_HOLD_REASON_PREFIX),
      domainAgedAt: { $exists: false },
      domainRegisteredAt: { $exists: false },
      $or: [{ domainAgeCheckedAt: { $exists: false } }, { domainAgeCheckedAt: { $lte: retryBefore } }],
    })
      .sort({ triggeredAt: 1, _id: 1 })
      .limit(limit)
      .lean();
  },
  /** Stores the recheck's lookup on a still-pending hold; `registeredAt` is absent when RDAP did not answer. */
  async recordDomainAgeCheck(domain: string, checkedAt: Date, registeredAt?: Date): Promise<boolean> {
    const result = await SignupDomainReviewModel.updateOne(
      { domain, status: 'held_pending_review' },
      { $set: { domainAgeCheckedAt: checkedAt, ...(registeredAt ? { domainRegisteredAt: registeredAt } : {}) } }
    );
    return result.modifiedCount === 1;
  },
  /**
   * Marks pending young-domain holds whose domain was registered at or before `registeredBefore` as
   * aged. Only a hint for the admin: the status is left alone. Returns how many were marked.
   */
  async markAgedDomains(registeredBefore: Date, agedAt: Date): Promise<number> {
    const result = await SignupDomainReviewModel.updateMany(
      {
        status: 'held_pending_review',
        reason: prefixRegex(YOUNG_DOMAIN_HOLD_REASON_PREFIX),
        domainAgedAt: { $exists: false },
        domainRegisteredAt: { $lte: registeredBefore },
      },
      { $set: { domainAgedAt: agedAt } }
    );
    return result.modifiedCount;
  },
};
