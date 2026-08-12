import mongoose, { Model, Schema } from 'mongoose';
import { IScopedSetting, IScopedSettingsRepository, ScopeRef, SettingKey, SettingScopeLevel } from '@bike4mind/common';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

/**
 * Overlay store for org/owner/lake setting OVERRIDES (epic #1658 lane 0 / #1660). Platform values
 * stay in `AdminSettings`; this collection holds only the narrower rungs, so the platform read path
 * and every consumer on it are untouched. A row exists only when an operator has actually set an
 * override - absence means "inherit the wider scope", never a stored default (the epic's "a lever
 * with no consumer is worse than no lever" rule applies to this table too).
 *
 * The resolver (`resolveScopedSetting`) validates every value through `settingsMap[key].schema`, and
 * refuses to scope a sensitive setting, so values here are non-secret operational levers and are
 * stored in the clear (unlike `AdminSettings`, which decrypts sensitive rows on the way out).
 */
interface IScopedSettingsMethods {}

interface IScopedSettingsModel extends Model<IScopedSetting, {}, IScopedSettingsMethods> {}

const ScopedSettingSchema = new Schema<IScopedSetting, IScopedSettingsModel, IScopedSettingsMethods>(
  {
    scopeLevel: {
      type: String,
      required: true,
      enum: [SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake],
    },
    scopeId: { type: String, required: true },
    ownerType: { type: String, enum: ['User', 'Organization'] },
    settingName: { type: String, required: true },
    settingValue: { type: String, required: true },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ScopedSettingSchema.plugin(softDeletePlugin);

// One override per (rung address, setting). unique is a data constraint, not a query hint - it is the
// invariant the resolver's "narrowest wins" relies on: there is never more than one candidate value
// to pick from at a given altitude.
ScopedSettingSchema.index({ scopeLevel: 1, scopeId: 1, settingName: 1 }, { unique: true });

export const ScopedSetting =
  (mongoose.models.ScopedSetting as IScopedSettingsModel) ??
  mongoose.model<IScopedSetting, IScopedSettingsModel>('ScopedSetting', ScopedSettingSchema);

class ScopedSettingsRepository extends BaseRepository<IScopedSetting> implements IScopedSettingsRepository {
  constructor(model: IScopedSettingsModel) {
    super(model);
  }

  async findOverrides(scopes: ScopeRef[], settingNames: SettingKey[]): Promise<IScopedSetting[]> {
    // No rungs in scope (a platform-altitude read) or nothing to look up: touch nothing.
    if (scopes.length === 0 || settingNames.length === 0) return [];
    const result = await this.model.find({
      $or: scopes.map(s => ({ scopeLevel: s.scopeLevel, scopeId: s.scopeId })),
      settingName: { $in: settingNames },
    });
    return result.map(r => r.toJSON());
  }
}

export const scopedSettingsRepository = new ScopedSettingsRepository(ScopedSetting);
