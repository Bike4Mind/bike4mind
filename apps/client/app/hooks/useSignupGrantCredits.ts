import { useGetSettingsValue } from './data/settings';
import { nonnegativeGrantCredits } from '@bike4mind/common';
import { useSignupGrantSchedule } from './useSignupGrantSchedule';

export function useSignupGrantCredits() {
  const enabled = useGetSettingsValue('stagedSignupGrantEnabled');
  const legacy = useGetSettingsValue('defaultFreeCredits');
  const { initialCredits } = useSignupGrantSchedule();
  return enabled === true || enabled === 'true' ? initialCredits : nonnegativeGrantCredits(legacy);
}
