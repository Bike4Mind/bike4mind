import { AdminSettings } from '@bike4mind/database/infra';
import { settingsMap, SettingKey } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi({ auth: false }).get(async (req, res) => {
  // Fetch branding settings - these are public information
  const brandingSettingNames: SettingKey[] = ['logoSettings', 'tagLineMain', 'tagLineSub'];
  const brandingSettings = await AdminSettings.find({
    settingName: { $in: brandingSettingNames },
  });

  const result: Record<string, any> = {};

  for (const settingName of brandingSettingNames) {
    const setting = brandingSettings.find(s => s.settingName === settingName);

    if (!setting) {
      const defaultValue = settingsMap[settingName]?.defaultValue;
      result[settingName] = defaultValue;
      continue;
    }

    // Use schema to parse value (handles JSON strings via z.preprocess in makeObjectSetting)
    const settingConfig = settingsMap[settingName];
    const parsed = settingConfig?.schema.safeParse(setting.settingValue);
    result[settingName] = parsed?.success ? parsed.data : settingConfig?.defaultValue;
  }

  return res.json(result);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
