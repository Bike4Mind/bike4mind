import mongoose, { Model, model, Schema } from 'mongoose';
import {
  IOrgDomainClaimDocument,
  IOrgDomainClaimRepository,
  MarkOrgDomainClaimVerifiedResult,
  OrgDomainClaimOwner,
  OrgDomainJoinPolicy,
  normalizeSignupRuleDomain,
  ORG_DOMAIN_JOIN_POLICIES,
  orgDomainPathIdSchema,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

export interface IOrgDomainClaimModel extends Model<IOrgDomainClaimDocument> {}

// Read old case aliases without rewriting claim rows or colliding with their unique index.
const organizationIdFilter = (organizationId: string) => ({
  $regex: `^${orgDomainPathIdSchema.parse(organizationId)}$`,
  $options: 'i',
});

const ownerFilter = (owner: OrgDomainClaimOwner) =>
  owner.organizationId !== undefined
    ? { organizationId: organizationIdFilter(owner.organizationId) }
    : { spaceId: owner.spaceId };

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
    const docs = await this.model.find({ organizationId: organizationIdFilter(organizationId) }).sort({ createdAt: 1 });
    return docs.map(doc => doc.toJSON());
  }

  countByOrganization(organizationId: string) {
    return this.model.countDocuments({ organizationId: organizationIdFilter(organizationId) });
  }

  async findByIdForOrg(id: string, organizationId: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOne({ _id: id, organizationId: organizationIdFilter(organizationId) });
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
      organizationId: { $exists: true },
    });
    return doc?.toJSON() ?? null;
  }

  async findVerifiedSpaceClaimByDomain(domain: string) {
    const doc = await this.model.findOne({
      domain: normalizeSignupRuleDomain(domain),
      status: 'verified',
      policy: 'suggest',
      spaceId: { $exists: true },
    });
    return doc?.toJSON() ?? null;
  }

  async findVerifiedSpaceClaimsByDomain(domain: string) {
    const docs = await this.model.find({
      domain: normalizeSignupRuleDomain(domain),
      status: 'verified',
      spaceId: { $exists: true },
    });
    return docs.map(doc => doc.toJSON());
  }

  async deleteSpaceClaimsByDomain(domain: string) {
    const claims = await this.findVerifiedSpaceClaimsByDomain(domain);
    if (claims.length === 0) return [];
    await this.model.deleteMany({ _id: { $in: claims.map(claim => claim.id) } });
    return claims;
  }

  async markVerified(id: string, owner: OrgDomainClaimOwner): Promise<MarkOrgDomainClaimVerifiedResult> {
    if (!mongoose.isValidObjectId(id)) return null;
    // autoIndex builds lazily; the partial unique index must exist before two verifies can race.
    await this.model.init();
    try {
      // Ordinary conditional updates work on DocumentDB 5 and preserve the first verification time.
      const first = await this.model.findOneAndUpdate(
        { _id: id, ...ownerFilter(owner), verifiedAt: null },
        { $set: { status: 'verified', verifiedAt: new Date() } },
        { new: true }
      );
      if (first) return first.toJSON();
      const existing = await this.model.findOneAndUpdate(
        { _id: id, ...ownerFilter(owner), verifiedAt: { $ne: null } },
        { $set: { status: 'verified' } },
        { new: true }
      );
      return existing?.toJSON() ?? null;
    } catch (err) {
      if (isDuplicateKeyError(err)) return 'conflict';
      throw err;
    }
  }

  async updatePolicy(id: string, organizationId: string, update: { policy: OrgDomainJoinPolicy }) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOneAndUpdate(
      { _id: id, organizationId: organizationIdFilter(organizationId) },
      { $set: { policy: update.policy } },
      { new: true }
    );
    return doc?.toJSON() ?? null;
  }

  async deleteForOrg(id: string, organizationId: string) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.model.deleteOne({ _id: id, organizationId: organizationIdFilter(organizationId) });
    return result.deletedCount > 0;
  }

  async deleteByOrganization(organizationId: string) {
    const result = await this.model.deleteMany({ organizationId: organizationIdFilter(organizationId) });
    return result.deletedCount;
  }

  async listBySpace(spaceId: string) {
    const docs = await this.model.find({ spaceId }).sort({ createdAt: 1 });
    return docs.map(doc => doc.toJSON());
  }

  countBySpace(spaceId: string) {
    return this.model.countDocuments({ spaceId });
  }

  async findByIdForSpace(id: string, spaceId: string) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOne({ _id: id, spaceId });
    return doc?.toJSON() ?? null;
  }

  async updatePolicyForSpace(id: string, spaceId: string, update: { policy: OrgDomainJoinPolicy }) {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findOneAndUpdate(
      { _id: id, spaceId },
      { $set: { policy: update.policy } },
      { new: true }
    );
    return doc?.toJSON() ?? null;
  }

  async deleteForSpace(id: string, spaceId: string) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.model.deleteOne({ _id: id, spaceId });
    return result.deletedCount > 0;
  }

  async deleteBySpace(spaceId: string) {
    const result = await this.model.deleteMany({ spaceId });
    return result.deletedCount;
  }
}

export const OrgDomainClaimSchema = new Schema<IOrgDomainClaimDocument, IOrgDomainClaimModel>(
  {
    // Exactly one of organizationId or spaceId is set (pre-validate hook). Mongoose runs getters and
    // validators on absent paths, so both skip an absent value or toJSON() would throw on the other owner.
    organizationId: {
      type: String,
      lowercase: true,
      validate: (value: string | undefined) => value === undefined || orgDomainPathIdSchema.safeParse(value).success,
      get: (value: unknown) => (value === undefined || value === null ? value : orgDomainPathIdSchema.parse(value)),
    },
    spaceId: {
      type: String,
      validate: (value: string | undefined) => value === undefined || mongoose.isValidObjectId(value),
    },
    // Normalized at the model boundary: the domain is the lookup key for joins and the unique index.
    domain: { type: String, required: true, set: normalizeSignupRuleDomain },
    status: { type: String, enum: ['pending', 'verified'], default: 'pending' },
    verificationToken: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    policy: { type: String, enum: ORG_DOMAIN_JOIN_POLICIES, default: 'off' },
    createdBy: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, getters: true },
    toObject: { virtuals: true, getters: true },
  }
);

OrgDomainClaimSchema.pre('validate', function () {
  if ((this.organizationId == null) === (this.spaceId == null)) {
    this.invalidate('organizationId', 'A domain claim needs exactly one of organizationId or spaceId');
  }
});

// Key order is reversed from the legacy unnamed {organizationId, domain} index so both coexist until
// the migration that drops the legacy one; that index cannot tell Space claims apart.
OrgDomainClaimSchema.index(
  { domain: 1, organizationId: 1 },
  { unique: true, name: 'org_domain_claim_org_domain', partialFilterExpression: { organizationId: { $exists: true } } }
);
OrgDomainClaimSchema.index(
  { spaceId: 1, domain: 1 },
  { unique: true, name: 'org_domain_claim_space_domain', partialFilterExpression: { spaceId: { $exists: true } } }
);
// One verified claim per domain across all orgs; this is what makes a concurrent second verify lose.
OrgDomainClaimSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { status: 'verified' } });

export const OrgDomainClaim =
  (mongoose.models.OrgDomainClaim as unknown as IOrgDomainClaimModel) ??
  model<IOrgDomainClaimDocument, IOrgDomainClaimModel>('OrgDomainClaim', OrgDomainClaimSchema);

export const orgDomainClaimRepository = new OrgDomainClaimRepository(OrgDomainClaim);

export default OrgDomainClaim;
