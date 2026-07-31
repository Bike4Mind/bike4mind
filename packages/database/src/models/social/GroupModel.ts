import mongoose from 'mongoose';
import { IGroupDocument, IGroupRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';

export const GroupSchema = new mongoose.Schema<IGroupDocument>(
  {
    name: { type: String, required: true },
    // Optional metadata. NOT required: Mongoose treats '' as missing, so a required
    // description would 500 the create route (which defaults an omitted description to '').
    description: { type: String, default: '' },
    // GroupType key (GROUP_TYPE_CATALOG). Required - groups are provisioned via a type grant,
    // never untyped. Safe as required: the prod Group collection is empty (org-groups #1172 audit).
    type: { type: String, required: true },
    // Owning organization. The create route already passes this and IGroup types it,
    // but it was missing from the schema, so strict mode silently dropped it on write -
    // which left group.organizationId undefined and broke group-scoped invite auth.
    organizationId: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

GroupSchema.plugin(softDeletePlugin);

// One LIVE group per (organization, type) - the epic's "one group per type per org in v1"
// invariant. The partial filter scopes uniqueness to live rows so revoke (soft-delete) then
// re-grant of the same type still works. Also serves findByOrganization (organizationId prefix).
//
// The `$type: 'string'` guards are load-bearing, not cosmetic: legacy Group rows predate both
// `type` and `organizationId` (strict mode dropped organizationId before it was in the schema),
// so they carry neither field and `deletedAt` defaults to null - they would all key as
// (null, null) and collide with E11000 on index build. Requiring both to be real strings excludes
// them, mirroring the email_1 partial index. MUST stay identical to the migration
// (20260730000000) or autoIndex and the migrator conflict (IndexKeySpecsConflict).
GroupSchema.index(
  { organizationId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null, organizationId: { $type: 'string' }, type: { $type: 'string' } },
    name: 'group_org_type_live',
  }
);

export const Group: mongoose.Model<IGroupDocument> =
  mongoose.models.Group ?? mongoose.model<IGroupDocument>('Group', GroupSchema);

export class GroupRepository extends BaseRepository<IGroupDocument> implements IGroupRepository {
  /** Live instances (the soft-delete plugin's find hook excludes `deletedAt` rows). */
  async findByOrganization(organizationId: string): Promise<IGroupDocument[]> {
    const groups = await this.model.find({ organizationId });
    return groups.map(group => group.toObject());
  }

  /**
   * Provision a group, treating a concurrent create for the same (organizationId, type) as
   * success (org-groups #1222). The caller (setOrganizationGroupTypes) checks "does a live
   * instance exist" and calls this only when it does not - but two overlapping grant PUTs can
   * both pass that check before either writes, so the second `create` collides with the
   * `group_org_type_live` unique index. E11000 carries no HTTP status (errorHandler falls through
   * to a 500 that pages on-call), so the fix lives HERE at the repo boundary rather than teaching
   * the service about Mongo error codes.
   *
   * The recovery differs by caller, and the transactional case is the non-obvious one:
   * - Outside a transaction, the read below returns the winner's row and we hand it back.
   * - Inside one (the group-types route, the only production caller today), E11000 has ALREADY
   *   aborted the transaction server-side, so the read cannot run on that session: it throws
   *   NoSuchTransaction (251) instead. Unlike E11000, 251 IS labeled TransientTransactionError, so
   *   withTransaction retries the whole callback and the retry's "does a live instance exist"
   *   precheck sees the committed winner and skips the create. The read never returns a row on
   *   this path - it converts an unretryable error into a retryable one. Do not "simplify" it to a
   *   bare rethrow: that reinstates the 500. Covered only by non-transactional tests, since the
   *   suite's mongodb-memory-server is a standalone (no transactions).
   */
  async createIfMissing(data: Pick<IGroupDocument, 'name' | 'description' | 'type' | 'organizationId'>) {
    try {
      return await this.create(data);
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;

      // Lost the race - the winner's row must exist (that's what E11000 means). If it somehow
      // doesn't (e.g. a concurrent revoke soft-deleted it in the instant between our create
      // attempt and this read), surface that as the original duplicate-key error rather than a
      // confusing "group not found" - the caller is expecting a group back, not a null.
      const existing = await this.findOne({ organizationId: data.organizationId, type: data.type, deletedAt: null });
      if (existing) return existing;
      throw error;
    }
  }
}

export const groupRepository = new GroupRepository(Group);

export default Group;
