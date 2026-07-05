import { IAdminSettingsRepository } from '@bike4mind/common';

interface ListAdminSettingsAdapters {
  db: {
    adminSettings: IAdminSettingsRepository;
  };
}

export const listAdminSettings = async ({ db }: ListAdminSettingsAdapters) => {
  const settings = await db.adminSettings.findAll();

  return settings;
};
