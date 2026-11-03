import { useGetSettingsValue, useSettingsFromServer } from '@client/app/hooks/data/settings';

/**
 * Whether the preference arena is switched on (the `preferenceArenaEnabled` admin setting).
 * False until the stored settings load, so a deployment that has it off never flashes the nav row.
 */
export function usePreferenceArenaEnabled(): boolean {
  const { isSuccess } = useSettingsFromServer();
  const value = useGetSettingsValue('preferenceArenaEnabled');
  return isSuccess && String(value) === 'true';
}
