import mongoose, { Model, Schema } from 'mongoose';
import { IAdminSettings, IAdminSettingsRepository, SettingKey, settingsMap, SettingValue } from '@bike4mind/common';
import { decryptAtRest } from '@bike4mind/utils';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

/**
 * Sensitive setting values are stored encrypted at rest (see apps/client settings/update.ts
 * and the backfill migration). Decrypt on the way out so server consumers - apiKeyService,
 * getSettingsMap, the Slack/integration readers - transparently receive plaintext. Gated so
 * only an isSensitive key whose value is a ciphertext string is touched: sreAgentConfig (an
 * object, manages its own per-repo secrets) and any not-yet-migrated plaintext value pass
 * through unchanged. Mutates the passed plain object in place and returns it.
 */
function decryptSettingInPlace<T extends { settingName?: string; settingValue?: unknown }>(setting: T): T;
function decryptSettingInPlace<T extends { settingName?: string; settingValue?: unknown }>(setting: T | null): T | null;
function decryptSettingInPlace(setting: { settingName?: string; settingValue?: unknown } | null) {
  if (!setting || typeof setting.settingValue !== 'string') return setting;
  const definition = settingsMap[setting.settingName as SettingKey] as { isSensitive?: boolean } | undefined;
  if (definition?.isSensitive) {
    setting.settingValue = decryptAtRest(setting.settingValue);
  }
  return setting;
}

interface IAdminSettingsMethods {}

interface IAdminSettingsModel extends Model<IAdminSettings, {}, IAdminSettingsMethods> {}

const AdminSettingsSchema = new Schema<IAdminSettings, IAdminSettingsModel, IAdminSettingsMethods>(
  {
    settingValue: { type: Schema.Types.Mixed, required: true },
    settingName: { type: String, required: true, unique: true },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

AdminSettingsSchema.plugin(softDeletePlugin);

export const AdminSettings =
  (mongoose.models.AdminSettings as IAdminSettingsModel) ??
  mongoose.model<IAdminSettings, IAdminSettingsModel>('AdminSettings', AdminSettingsSchema);

class AdminSettingsRepository extends BaseRepository<IAdminSettings> implements IAdminSettingsRepository {
  constructor(model: IAdminSettingsModel) {
    super(model);
  }

  async findBySettingName(settingName: IAdminSettings['settingName']) {
    const setting = await this.model.findOne({ settingName }).lean();
    return decryptSettingInPlace(setting as (IAdminSettings & { settingName: string }) | null);
  }

  async findBySettingNames(settingNames: IAdminSettings['settingName'][]) {
    const result = await this.model.find({ settingName: { $in: settingNames } });
    return result.map(r => decryptSettingInPlace(r.toJSON()));
  }

  async findAllByTag(tag: string) {
    const result = await this.model.find({ tags: { $in: [tag] } });
    return result.map(r => decryptSettingInPlace(r.toJSON()));
  }

  async findAll() {
    const result = await this.model.find();
    return result.map(r => decryptSettingInPlace(r.toJSON()));
  }

  async getSettingsValue<K extends SettingKey>(settingName: K): Promise<SettingValue<K> | undefined> {
    const setting = decryptSettingInPlace(await this.findOne({ settingName }));
    const value = settingsMap?.[settingName]?.schema?.safeParse(setting?.settingValue);

    if (value.success) {
      return value.data as SettingValue<K>;
    } else {
      return settingsMap?.[settingName]?.defaultValue as SettingValue<K> | undefined;
    }
  }
}

export const adminSettingsRepository = new AdminSettingsRepository(AdminSettings);
