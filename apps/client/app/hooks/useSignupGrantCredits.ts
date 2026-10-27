import { useGetSettingsValue } from './data/settings';
import { nonnegativeGrantCredits } from '@bike4mind/common';

export function useSignupGrantCredits() {
  const enabled = useGetSettingsValue('stagedSignupGrantEnabled');
  const signup = useGetSettingsValue('signupGrantCredits');
  const legacy = useGetSettingsValue('defaultFreeCredits');
  return nonnegativeGrantCredits(enabled === true || enabled === 'true' ? (signup ?? legacy) : legacy);
}
