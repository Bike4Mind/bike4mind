import mongoose, { Model, Schema } from 'mongoose';
import { IInternalTeamMemberDocument, IInternalTeamMemberRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface IInternalTeamMemberMethods {}

interface IInternalTeamMemberModel extends Model<IInternalTeamMemberDocument, {}, IInternalTeamMemberMethods> {}

const InternalTeamMemberSchema = new Schema<IInternalTeamMemberDocument, IInternalTeamMemberModel>(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    role: { type: String },
    department: { type: String },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

InternalTeamMemberSchema.index({ phone: 1 }, { unique: true });
InternalTeamMemberSchema.index({ isActive: 1, name: 1 });

export const InternalTeamMember =
  (mongoose.models.InternalTeamMember as IInternalTeamMemberModel) ??
  mongoose.model<IInternalTeamMemberDocument, IInternalTeamMemberModel>('InternalTeamMember', InternalTeamMemberSchema);

class InternalTeamMemberRepository
  extends BaseRepository<IInternalTeamMemberDocument>
  implements IInternalTeamMemberRepository
{
  constructor(model: IInternalTeamMemberModel) {
    super(model);
  }

  async findAllActive(): Promise<IInternalTeamMemberDocument[]> {
    const result = await this.model.find({ isActive: true }).sort({ name: 1 });
    return result.map(r => r.toJSON());
  }

  async findByPhone(phone: string): Promise<IInternalTeamMemberDocument | null> {
    const result = await this.model.findOne({ phone });
    return result ? (result.toJSON() as IInternalTeamMemberDocument) : null;
  }
}

export const internalTeamMemberRepository = new InternalTeamMemberRepository(InternalTeamMember);
