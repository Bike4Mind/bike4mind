import { FULL_ADMIN_SETTING_KEYS, isFullAdmin } from '@bike4mind/common';

type SettingsEditor = Parameters<typeof isFullAdmin>[0];

export const FULL_ADMIN_ONLY_SETTING_NOTE = 'Only full administrators can change this setting.';

/** The note that locks a setting the server refuses to a delegate (settings/update.ts), or undefined when editable. */
export function fullAdminOnlySettingNote(user: SettingsEditor, key: string): string | undefined {
  return FULL_ADMIN_SETTING_KEYS.has(key) && !isFullAdmin(user) ? FULL_ADMIN_ONLY_SETTING_NOTE : undefined;
}
