import mongoose, { Schema } from 'mongoose';
import type { SignupDomainReview, SignupObservation, SignupProtectionRepository } from '@bike4mind/common';
import { emailDomainCandidates } from '@bike4mind/common';
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

const reviewSchema = new Schema<SignupDomainReview & { reviewedBy?: string; reviewedAt?: Date }>({
  domain: { type: String, required: true, unique: true },
  status: { type: String, enum: ['held_pending_review', 'blocked', 'released'], required: true },
  reason: { type: String, required: true },
  triggeredAt: { type: Date, required: true },
  cohortUserIds: { type: [String], default: [] },
  sampleEmails: { type: [String], default: [] },
  signupCount: { type: Number, required: true },
  reviewedBy: String,
  reviewedAt: Date,
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
