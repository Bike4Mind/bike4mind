import mongoose, { Model, Schema } from 'mongoose';
import type {
  ILakeMembershipChangeEventDocument,
  ILakeMembershipChangeEventRepository,
  RecordLakeMembershipChangeInput,
} from '@bike4mind/common';
import {
  LAKE_MEMBERSHIP_CHANGE_ACTIONS,
  LAKE_MEMBERSHIP_CHANGE_ORIGINS,
  LAKE_MEMBERSHIP_CHANGE_PRINCIPAL_KINDS,
  lakeMembershipChangeExpiresAt,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'LakeMembershipChangeEvent';

/**
 * The write-side membership audit trail: one document per accepted lake membership write,
 * recording that a file joined or left a lake, WHO drove it, and whether it came from an
 * automated connector or a person. See LakeMembershipChangeEventTypes.ts for the field-by-field
 * rationale, including why this is a sibling of LakeConfigChangeEventModel rather than a new
 * action on it.
 */
interface ILakeMembershipChangeEventModel extends Model<ILakeMembershipChangeEventDocument> {}

const LakeMembershipChangeEventSchema = new Schema<ILakeMembershipChangeEventDocument>(
  {
    principalKind: { type: String, enum: LAKE_MEMBERSHIP_CHANGE_PRINCIPAL_KINDS, required: true },
    principalId: { type: String, required: true },
    onBehalfOfUserId: { type: String },
    organizationId: { type: String },
    dataLakeId: { type: String, required: true },
    fabFileId: { type: String, required: true },
    action: { type: String, enum: LAKE_MEMBERSHIP_CHANGE_ACTIONS, required: true },
    origin: { type: String, enum: LAKE_MEMBERSHIP_CHANGE_ORIGINS, required: true },
    // `immutable` blocks the ordinary updateOne/updateMany/findOneAndUpdate paths, the same
    // backstop LakeConfigChangeEventModel applies to its own `expiresAt` - NOT a guarantee against
    // a caller that deliberately opts out or reaches the collection via the raw driver. The
    // repository below exposes no update/delete at all.
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LakeMembershipChangeEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// "What joined or left this lake, newest first?" - the only query shape a reader will ever want
// (#3053), mirroring LakeConfigChangeEventModel's identical index and its own reasoning: `_id: -1`
// is part of the key, not decoration - without it the planner cannot supply a stable sort for two
// events written in the same millisecond and falls back to a blocking SORT over the whole
// retention window.
LakeMembershipChangeEventSchema.index({ dataLakeId: 1, createdAt: -1, _id: -1 });

export const LakeMembershipChangeEventModel: ILakeMembershipChangeEventModel =
  (mongoose.models[ModelName] as ILakeMembershipChangeEventModel) ||
  mongoose.model<ILakeMembershipChangeEventDocument, ILakeMembershipChangeEventModel>(
    ModelName,
    LakeMembershipChangeEventSchema
  );

class LakeMembershipChangeEventRepository
  extends BaseRepository<ILakeMembershipChangeEventDocument>
  implements ILakeMembershipChangeEventRepository
{
  constructor(private eventModel: mongoose.Model<ILakeMembershipChangeEventDocument>) {
    super(eventModel);
  }

  async record(input: RecordLakeMembershipChangeInput): Promise<ILakeMembershipChangeEventDocument> {
    // The real wall clock, always - no caller-facing override, matching lakeConfigChangeEventRepository.
    const now = new Date();
    const created = await this.eventModel.create({
      principalKind: input.principalKind,
      principalId: input.principalId,
      onBehalfOfUserId: input.onBehalfOfUserId,
      organizationId: input.organizationId,
      dataLakeId: input.dataLakeId,
      fabFileId: input.fabFileId,
      action: input.action,
      origin: input.origin,
      expiresAt: lakeMembershipChangeExpiresAt(now),
    });
    return created.toJSON() as unknown as ILakeMembershipChangeEventDocument;
  }

  async listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeMembershipChangeEventDocument[]> {
    const query = this.eventModel.find({ dataLakeId: lakeId }).sort({ createdAt: -1, _id: -1 });
    if (opts?.limit) query.limit(opts.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as ILakeMembershipChangeEventDocument);
  }

  async listByLakeSince(
    lakeId: string,
    since: Date,
    opts?: { limit?: number }
  ): Promise<ILakeMembershipChangeEventDocument[]> {
    // `$gt`, not `$gte`: the bound is exclusive so two adjacent windows partition the log instead
    // of both claiming a change written exactly on the boundary.
    const query = this.eventModel
      .find({ dataLakeId: lakeId, createdAt: { $gt: since } })
      .sort({ createdAt: -1, _id: -1 });
    if (opts?.limit) query.limit(opts.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as ILakeMembershipChangeEventDocument);
  }

  async oldestEventAt(lakeId: string): Promise<Date | undefined> {
    const doc = await this.eventModel
      .findOne({ dataLakeId: lakeId })
      .sort({ createdAt: 1, _id: 1 })
      .select({ createdAt: 1 })
      .lean();
    return doc?.createdAt ?? undefined;
  }
}

export const lakeMembershipChangeEventRepository: ILakeMembershipChangeEventRepository =
  new LakeMembershipChangeEventRepository(LakeMembershipChangeEventModel);
