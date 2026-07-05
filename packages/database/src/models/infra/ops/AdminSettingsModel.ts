import mongoose, { Model, Schema } from 'mongoose';
import { IAdminSettings, IAdminSettingsRepository, SettingKey, settingsMap, SettingValue } from '@bike4mind/common';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

interface IAdminSettingsMethods {
}

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
    return this.model.findOne({ settingName });
  }

  async findBySettingNames(settingNames: IAdminSettings['settingName'][]) {
    const result = await this.model.find({ settingName: { $in: settingNames } });
    return result.map(r => r.toJSON());
  }

  async findAllByTag(tag: string) {
    const result = await this.model.find({ tags: { $in: [tag] } });
    return result.map(r => r.toJSON());
  }

  async findAll() {
    return this.model.find();
  }

  async getSettingsValue<K extends SettingKey>(settingName: K): Promise<SettingValue<K> | undefined> {
    const setting = await this.findOne({ settingName });
    const value = settingsMap?.[settingName]?.schema?.safeParse(setting?.settingValue);

    if (value.success) {
      return value.data as SettingValue<K>;
    } else {
      return settingsMap?.[settingName]?.defaultValue as SettingValue<K> | undefined;
    }
  }
}

export const adminSettingsRepository = new AdminSettingsRepository(AdminSettings);
