import { settingsMap } from '@bike4mind/common';

/** EnableLoops is in the Experimental settings group, which non-admins may read here. */
export const SETTINGS_PATH = '/api/settings/fetch';

/** The admin's EnableLoops from the user-readable settings rows: a missing row is the default, a non-array undefined. */
export function readLoopsEnabled(rows: unknown): boolean | undefined {
  if (!Array.isArray(rows)) return undefined;
  const row = (rows as { settingName?: unknown; settingValue?: unknown }[]).find(
    entry => entry?.settingName === 'EnableLoops'
  );
  const parsed = settingsMap.EnableLoops.schema.safeParse(row?.settingValue);
  return parsed.success ? parsed.data === true : settingsMap.EnableLoops.defaultValue === true;
}
