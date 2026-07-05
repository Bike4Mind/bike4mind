import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';
import { extractFilename } from '@bike4mind/utils';
import { LogoSettings } from '@bike4mind/common';

const migration: MigrationFile = {
  id: 20251107195534,
  name: 'convert admin logo values to filepath',

  up: async () => {
    console.log('Starting migration: Converting admin logo values to filepath...');

    const logoSettings = await AdminSettings.findOne({ settingName: 'logoSettings' });
    if (!logoSettings) return;

    const logoPath = 'admin/logos';

    if (typeof logoSettings.settingValue === 'string') {
      console.log('Detected string value');
      const parsed = JSON.parse(logoSettings.settingValue);
      // Extract the filename from the URL and just store the filename
      if (parsed.customLogoUrl) {
        parsed.customLogoUrl = `${logoPath}/${extractFilename(parsed.customLogoUrl)}`;
      }
      if (parsed.customDarkLogoUrl) {
        parsed.customDarkLogoUrl = `${logoPath}/${extractFilename(parsed.customDarkLogoUrl)}`;
      }
      logoSettings.settingValue = JSON.stringify(parsed);
      await logoSettings.save();
    } else {
      console.log('Detected object value');
      const settingValue = logoSettings.settingValue as LogoSettings;
      if (settingValue.customLogoUrl) {
        settingValue.customLogoUrl = `${logoPath}/${extractFilename(settingValue.customLogoUrl)}`;
        console.log(
          `Converted custom logo url from ${settingValue.customLogoUrl} to ${logoPath}/${extractFilename(settingValue.customLogoUrl)}`
        );
      }
      if (settingValue.customDarkLogoUrl) {
        settingValue.customDarkLogoUrl = `${logoPath}/${extractFilename(settingValue.customDarkLogoUrl)}`;
        console.log(
          `Converted custom dark logo url from ${settingValue.customDarkLogoUrl} to ${logoPath}/${extractFilename(settingValue.customDarkLogoUrl)}`
        );
      }
      await AdminSettings.updateOne({ _id: logoSettings._id }, { settingValue: settingValue });
    }

    console.log('✅ Migration completed.');
  },

  down: async () => {},
};

export default migration;
