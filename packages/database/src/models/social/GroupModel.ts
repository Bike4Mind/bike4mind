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
   * Soft-delete by writing `deletedAt` directly via a Mongoose `updateMany`.
   * NOT the plugin's `deleteMany` static: that routes through the raw driver
   * (`this.collection.updateMany`), which Mongoose 8's transactionAsyncLocalStorage
   * does NOT inject a session into - so a soft-delete inside `withTransaction` would
   * escape the transaction and, on a transient-error retry, silently skip the member
   * purge. A real Mongoose query joins the session automatically (see BaseModel notes).
   */
  async softDeleteByIds(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.model.updateMany({ _id: { $in: groupIds }, deletedAt: null }, { $set: { deletedAt: new Date() } });
  }
}

export const groupRepository = new GroupRepository(Group);

export default Group;
