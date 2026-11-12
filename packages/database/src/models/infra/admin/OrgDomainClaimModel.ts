import mongoose, { Model, model, Schema } from 'mongoose';
import {
  IOrgDomainClaimDocument,
  IOrgDomainClaimRepository,
  MarkOrgDomainClaimVerifiedResult,
  OrgDomainDefaultRole,
  OrgDomainJoinPolicy,
  normalizeSignupRuleDomain,
  ORG_DOMAIN_DEFAULT_ROLES,
  ORG_DOMAIN_JOIN_POLICIES,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

export interface IOrgDomainClaimModel extends Model<IOrgDomainClaimDocument> {}

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export class OrgDomainClaimRepository
  extends BaseRepository<IOrgDomainClaimDocument>
  implements IOrgDomainClaimRepository
{
  constructor(model: IOrgDomainClaimModel) {
    super(model);
  }

  async listByOrganization(organizationId: string) {
    const docs = await this.model.find({ organizationId }).sort({ createdAt: 1 });
    return docs.map(doc => doc.toJSON());
  }

  countByOrganization(organizationId: string) {
    return this.model.countDocuments({ organizationId });
  }

  async findByIdForOrg(id: string, organizationId: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOne({ _id: id, organizationId });
    return doc?.toJSON() ?? null;
  }

  async findVerifiedByDomain(domain: string) {
    const doc = await this.model.findOne({ domain: normalizeSignupRuleDomain(domain), status: 'verified' });
    return doc?.toJSON() ?? null;
  }

  async findVerifiedJoinableByDomain(domain: string) {
    const doc = await this.model.findOne({
      domain: normalizeSignupRuleDomain(domain),
      status: 'verified',
      policy: { $ne: 'off' },
    });
    return doc?.toJSON() ?? null;
  }

  async markVerified(id: string, organizationId: string): Promise<MarkOrgDomainClaimVerifiedResult> {
    if (!mongoose.isValidObjectId(id)) return null;
    try {
      // The pipeline keeps the first verifiedAt on a re-verify, so the call is idempotent.
      const doc = await this.model.findOneAndUpdate(
        { _id: id, organizationId },
        [{ $set: { status: 'verified', verifiedAt: { $ifNull: ['$verifiedAt', '$$NOW'] } } }],
        { new: true }
      );
      return doc?.toJSON() ?? null;
    } catch (err) {
      if (isDuplicateKeyError(err)) return 'conflict';
      throw err;
    }
  }

  async updatePolicy(
    id: string,
    organizationId: string,
    update: { policy?: OrgDomainJoinPolicy; defaultRole?: OrgDomainDefaultRole }
  ) {
    if (!mongoose.isValidObjectId(id)) return null;
    const $set: Record<string, string> = {};
    if (update.policy !== undefined) $set.policy = update.policy;
    if (update.defaultRole !== undefined) $set.defaultRole = update.defaultRole;
    const doc = await this.model.findOneAndUpdate({ _id: id, organizationId }, { $set }, { new: true });
    return doc?.toJSON() ?? null;
  }

  async deleteForOrg(id: string, organizationId: string) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.model.deleteOne({ _id: id, organizationId });
    return result.deletedCount > 0;
  }

  async deleteByOrganization(organizationId: string) {
    const result = await this.model.deleteMany({ organizationId });
    return result.deletedCount;
  }
}

export const OrgDomainClaimSchema = new Schema<IOrgDomainClaimDocument, IOrgDomainClaimModel>(
  {
    organizationId: { type: String, required: true },
    // Normalized at the model boundary: the domain is the lookup key for joins and the unique index.
    domain: { type: String, required: true, set: normalizeSignupRuleDomain },
    status: { type: String, enum: ['pending', 'verified'], default: 'pending' },
    verificationToken: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    policy: { type: String, enum: ORG_DOMAIN_JOIN_POLICIES, default: 'off' },
    defaultRole: { type: String, enum: ORG_DOMAIN_DEFAULT_ROLES, default: 'member' },
    createdBy: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

OrgDomainClaimSchema.index({ organizationId: 1, domain: 1 }, { unique: true });
// One verified claim per domain across all orgs; this is what makes a concurrent second verify lose.
OrgDomainClaimSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { status: 'verified' } });

export const OrgDomainClaim =
  (mongoose.models.OrgDomainClaim as unknown as IOrgDomainClaimModel) ??
  model<IOrgDomainClaimDocument, IOrgDomainClaimModel>('OrgDomainClaim', OrgDomainClaimSchema);

export const orgDomainClaimRepository = new OrgDomainClaimRepository(OrgDomainClaim);

export default OrgDomainClaim;
