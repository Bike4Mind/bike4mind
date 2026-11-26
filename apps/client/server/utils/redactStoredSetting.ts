import { isMaskedSetting, redactSettingSecrets, type AdminSettingDoc } from '@bike4mind/common';
import { decryptAtRest } from '@bike4mind/utils/security';

/**
 * The read-path view of a stored AdminSettings row, shared by /api/settings and /api/settings/fetch.
 * Only a masked setting is decrypted, and only so its mask carries the real last-4; any other value
 * is returned exactly as stored.
 */
export function redactStoredSetting(setting: { settingName: string; settingValue?: unknown }): AdminSettingDoc {
  const value =
    isMaskedSetting(setting.settingName) && typeof setting.settingValue === 'string'
      ? decryptAtRest(setting.settingValue)
      : setting.settingValue;
  return redactSettingSecrets({ ...setting, settingValue: value } as unknown as AdminSettingDoc);
}
