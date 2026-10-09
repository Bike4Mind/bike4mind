import mongoose, { Model, Schema } from 'mongoose';
import {
  AdminSettingDoc,
  IAdminSettings,
  IAdminSettingsRepository,
  redactSettingSecrets,
  SettingKey,
  settingsMap,
  SettingValue,
} from '@bike4mind/common';
import { decryptAtRest } from '@bike4mind/utils/security';
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
      // Chokepoint: any code path that serialises a hydrated AdminSettings document
      // (e.g. res.json, JSON.stringify) gets a masked settingValue automatically.
      // Trusted reads that need plaintext must use .lean() + decryptSettingInPlace,
      // which bypasses this transform entirely. Does NOT decrypt -- decryption stays
      // in the repository layer where the key is available.
      transform: (_doc, ret) => redactSettingSecrets(ret as AdminSettingDoc),
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret) => redactSettingSecrets(ret as AdminSettingDoc),
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
    // lean({ virtuals: true }) keeps the id virtual the prior hydrated toJSON produced
    // (mongoose-lean-virtuals only fires with the flag - see packages/database/src/index.ts).
    const setting = await this.model.findOne({ settingName }).lean({ virtuals: true });
    return decryptSettingInPlace(setting as (IAdminSettings & { settingName: string }) | null);
  }

  async findBySettingNames(settingNames: IAdminSettings['settingName'][]) {
    // lean({ virtuals: true }) bypasses the toJSON masking transform so these trusted
    // callers receive plaintext after decryptSettingInPlace, same as findBySettingName.
    const result = await this.model.find({ settingName: { $in: settingNames } }).lean({ virtuals: true });
    return result.map(r => decryptSettingInPlace(r as IAdminSettings & { settingName: string }));
  }

  async findAllByTag(tag: string) {
    const result = await this.model.find({ tags: { $in: [tag] } }).lean({ virtuals: true });
    return result.map(r => decryptSettingInPlace(r as IAdminSettings & { settingName: string }));
  }

  async findAll() {
    const result = await this.model.find().lean({ virtuals: true });
    return result.map(r => decryptSettingInPlace(r as IAdminSettings & { settingName: string }));
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
