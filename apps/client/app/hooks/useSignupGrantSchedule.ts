import { useMemo } from 'react';
import { runtimeSignupGrantSchedule, storedGrantCredits, type SignupGrantSchedule } from '@bike4mind/common';
import { useSettingsFromServer } from './data/settings';

/**
 * Client mirror of resolveSignupGrantSchedule in b4m-core/common/src/signupGrant.ts. Reads the raw server
 * rows so an unset key resolves exactly as the server does; every schedule key is userReadable.
 */
export function useSignupGrantSchedule(): SignupGrantSchedule {
  const { data } = useSettingsFromServer();
  return useMemo(() => {
    const rows = new Map((data ?? []).map(row => [row.settingName, row.settingValue as unknown]));
    return runtimeSignupGrantSchedule(key => storedGrantCredits(key, rows.get(key)));
  }, [data]);
}
