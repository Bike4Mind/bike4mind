import { SettingKey, settingsMap } from '../../schemas';
import { IBaseRepository } from './BaseTypes';
import { type IMongoDocument } from './common';

import { z } from 'zod';

export const SettingTypeSchema = z.union([z.literal('string'), z.literal('number'), z.literal('boolean')]);

export type SettingType = 'string' | 'number' | 'boolean';

export interface ISettings {
  settingName: SettingKey;
  settingValue: string;
}

export interface IAdminSettings extends ISettings, IMongoDocument {}

export interface IAdminSettingsRepository extends IBaseRepository<IAdminSettings> {
  findBySettingName: (settingName: IAdminSettings['settingName']) => Promise<IAdminSettings | null>;
  findBySettingNames: (settingNames: IAdminSettings['settingName'][]) => Promise<IAdminSettings[]>;
  findAllByTag: (tag: string) => Promise<IAdminSettings[]>;
  findAll: () => Promise<IAdminSettings[]>;
  getSettingsValue: <K extends SettingKey>(
    settingName: K
  ) => Promise<z.infer<(typeof settingsMap)[K]['schema']> | undefined>;
}
