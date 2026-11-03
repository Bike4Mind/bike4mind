import mongoose, { Schema } from 'mongoose';
import type {
  SignupDomainHoldAutoPolicy,
  SignupDomainReview,
  SignupObservation,
  SignupProtectionRepository,
} from '@bike4mind/common';
import { emailDomainCandidates, SIGNUP_DOMAIN_HOLD_AUTO_POLICIES } from '@bike4mind/common';
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
});
reviewSchema.index({ triggeredAt: -1 });

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
};
