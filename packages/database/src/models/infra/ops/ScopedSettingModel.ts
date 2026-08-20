import mongoose, { Model, Schema } from 'mongoose';
import {
  IScopedSetting,
  IScopedSettingsRepository,
  ScopedOverrideWrite,
  ScopeRef,
  SettingKey,
  SettingScopeLevel,
} from '@bike4mind/common';
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

// One LIVE override per (rung address, setting). unique is a data constraint, not a query hint - it
// is the invariant the resolver's "narrowest wins" relies on: there is never more than one candidate
// value to pick from at a given altitude. The `scopeId` alone identifies the rung; `ownerType` is
// attribution only and deliberately NOT part of the key.
//
// The partial filter is load-bearing: softDeletePlugin does not remove rows, it stamps `deletedAt`
// (default `null` on every live row, a Date once deleted). Without `partialFilterExpression`, a
// soft-deleted tombstone keeps occupying the key, so clear-then-reset of an override at the same
// address would throw E11000 and leave the lever permanently unsettable. `deletedAt: null` indexes
// exactly the live rows (matching the plugin's default) and drops tombstones out. Precedent:
// ProjectModel's per-user unique name index.
ScopedSettingSchema.index(
  { scopeLevel: 1, scopeId: 1, settingName: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

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

  async upsertOverride(write: ScopedOverrideWrite): Promise<IScopedSetting> {
    // findOneAndUpdate is not covered by softDeletePlugin's find/findOne pre-hooks, so the
    // `deletedAt: null` filter is explicit here: it excludes a prior tombstone at this address from
    // matching (the partial unique index already excludes it from the collision check), so upsert
    // inserts a fresh row instead of colliding with it, exactly the case
    // ScopedSettingModel.integration.test.ts guards for the raw model.
    const doc = await this.model.findOneAndUpdate(
      { scopeLevel: write.scopeLevel, scopeId: write.scopeId, settingName: write.settingName, deletedAt: null },
      { $set: { settingValue: write.settingValue, ownerType: write.ownerType } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return doc.toJSON();
  }

  async clearOverride(ref: ScopeRef & { settingName: SettingKey }): Promise<void> {
    // deleteOne is the plugin-overridden static (soft delete via `deletedAt`); a missing row is a no-op.
    await this.model.deleteOne({ scopeLevel: ref.scopeLevel, scopeId: ref.scopeId, settingName: ref.settingName });
  }
}

export const scopedSettingsRepository = new ScopedSettingsRepository(ScopedSetting);
