import { useMemo } from 'react';
import { signupGrantScheduleFromValues, storedGrantCredits, type SignupGrantSchedule } from '@bike4mind/common';
import { useSettingsFromServer } from './data/settings';

/**
 * Client mirror of resolveSignupGrantSchedule in b4m-core/common/src/signupGrant.ts. Reads the raw
 * server rows rather than useGetSettingsValue, which fills an absent key with its registry default
 * and would hide the old-key fallback. Admin-only keys are not served here, so they read as unset.
 */
export function useSignupGrantSchedule(): SignupGrantSchedule {
  const { data } = useSettingsFromServer();
  return useMemo(() => {
    const rows = new Map((data ?? []).map(row => [row.settingName, row.settingValue as unknown]));
    return signupGrantScheduleFromValues(key => storedGrantCredits(key, rows.get(key)));
  }, [data]);
}
