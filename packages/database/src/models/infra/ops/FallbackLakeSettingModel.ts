import mongoose, { Model, Schema } from 'mongoose';
import {
  DATA_LAKE_GROUNDING_MODES,
  IFallbackLakeSetting,
  IFallbackLakeSettingsRepository,
  type DataLakeGroundingMode,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * Overlay store for a static (registry) data lake's admin-settable session defaults - see
 * IFallbackLakeSetting's doc comment. One row per registry lake id, upserted by
 * `setGroundingMode`; there is no soft-delete/tombstone scheme here (unlike ScopedSetting) because
 * there is no wider scope for an absent row to "inherit" - absence just means the coded default.
 */
interface IFallbackLakeSettingsMethods {}

interface IFallbackLakeSettingsModel extends Model<IFallbackLakeSetting, {}, IFallbackLakeSettingsMethods> {}

const FallbackLakeSettingSchema = new Schema<
  IFallbackLakeSetting,
  IFallbackLakeSettingsModel,
  IFallbackLakeSettingsMethods
>(
  {
    lakeId: { type: String, required: true, unique: true },
    groundingMode: { type: String, enum: DATA_LAKE_GROUNDING_MODES },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

export const FallbackLakeSetting =
  (mongoose.models.FallbackLakeSetting as IFallbackLakeSettingsModel) ??
  mongoose.model<IFallbackLakeSetting, IFallbackLakeSettingsModel>('FallbackLakeSetting', FallbackLakeSettingSchema);

class FallbackLakeSettingsRepository
  extends BaseRepository<IFallbackLakeSetting>
  implements IFallbackLakeSettingsRepository
{
  constructor(model: IFallbackLakeSettingsModel) {
    super(model);
  }

  async findByLakeId(lakeId: string): Promise<IFallbackLakeSetting | null> {
    const result = await this.model.findOne({ lakeId });
    return result?.toJSON() ?? null;
  }

  async findByLakeIds(lakeIds: string[]): Promise<IFallbackLakeSetting[]> {
    if (lakeIds.length === 0) return [];
    const results = await this.model.find({ lakeId: { $in: lakeIds } });
    return results.map(r => r.toJSON());
  }

  async setGroundingMode(lakeId: string, groundingMode: DataLakeGroundingMode): Promise<IFallbackLakeSetting> {
    const result = await this.model.findOneAndUpdate(
      { lakeId },
      { $set: { groundingMode } },
      { new: true, upsert: true }
    );
    return result.toJSON();
  }
}

export const fallbackLakeSettingsRepository = new FallbackLakeSettingsRepository(FallbackLakeSetting);
