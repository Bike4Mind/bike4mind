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

export const Group: mongoose.Model<IGroupDocument> =
  mongoose.models.Group ?? mongoose.model<IGroupDocument>('Group', GroupSchema);

export class GroupRepository extends BaseRepository<IGroupDocument> implements IGroupRepository {
  /** Live instances (the soft-delete plugin's find hook excludes `deletedAt` rows). */
  async findByOrganization(organizationId: string): Promise<IGroupDocument[]> {
    const groups = await this.model.find({ organizationId });
    return groups.map(group => group.toObject());
  }

  /** Soft-delete (the plugin turns deleteMany into a `deletedAt` set, not a hard delete). */
  async softDeleteByIds(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return;
    await this.model.deleteMany({ _id: { $in: groupIds } });
  }
}

export const groupRepository = new GroupRepository(Group);

export default Group;
