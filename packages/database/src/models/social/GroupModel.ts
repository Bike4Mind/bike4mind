import mongoose from 'mongoose';
import { IGroupDocument } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';

export const GroupSchema = new mongoose.Schema<IGroupDocument>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
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
export default Group;
