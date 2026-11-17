import mongoose, { Model, Schema, Types } from 'mongoose';

const ModelName = 'ProviderEndUserMapping';

/**
 * Resolves a provider end-user identifier that is not an account's own `User.providerEndUserId`:
 * the digest a platform API key sends for one of its own end users,
 * toProviderEndUserId(platformEndUserKey(ownerUserId, endUserId)) in @bike4mind/llm-adapters.
 * Read by the admin lookup at apps/client/pages/api/admin/users/by-provider-id.ts.
 */
export interface IProviderEndUserMapping {
  /** The 64-hex digest the providers receive. */
  providerEndUserId: string;
  /** The platform key's owner. */
  ownerUserId: Types.ObjectId;
  /** The `end_user_id` the platform sent, as given. */
  endUserId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface IProviderEndUserMappingModel extends Model<IProviderEndUserMapping> {}

const ProviderEndUserMappingSchema = new Schema<IProviderEndUserMapping, IProviderEndUserMappingModel>({
  providerEndUserId: { type: String, required: true, unique: true },
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  endUserId: { type: String, required: true },
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
});

// Account erasure deletes by owner.
ProviderEndUserMappingSchema.index({ ownerUserId: 1 });

export const ProviderEndUserMapping =
  (mongoose.models[ModelName] as unknown as IProviderEndUserMappingModel) ||
  mongoose.model<IProviderEndUserMapping, IProviderEndUserMappingModel>(ModelName, ProviderEndUserMappingSchema);

export class ProviderEndUserMappingRepository {
  constructor(private model: IProviderEndUserMappingModel) {}

  /** Records a sighting: creates the row on first sight, otherwise only moves `lastSeenAt`. */
  async recordSeen(
    entry: { providerEndUserId: string; ownerUserId: string; endUserId: string },
    now: Date = new Date()
  ): Promise<void> {
    await this.model.updateOne(
      { providerEndUserId: entry.providerEndUserId },
      {
        $setOnInsert: {
          ownerUserId: new Types.ObjectId(entry.ownerUserId),
          endUserId: entry.endUserId,
          firstSeenAt: now,
        },
        $set: { lastSeenAt: now },
      },
      { upsert: true }
    );
  }

  async findByProviderEndUserId(
    providerEndUserId: string
  ): Promise<Pick<IProviderEndUserMapping, 'ownerUserId' | 'endUserId'> | null> {
    return this.model.findOne({ providerEndUserId }).select('ownerUserId endUserId').lean();
  }

  async deleteAllForOwner(ownerUserId: string): Promise<number> {
    const result = await this.model.deleteMany({ ownerUserId: new Types.ObjectId(ownerUserId) });
    return result.deletedCount ?? 0;
  }
}

export const providerEndUserMappingRepository = new ProviderEndUserMappingRepository(ProviderEndUserMapping);
