import { useGetSettingsValue } from './data/settings';

export function useSignupGrantCredits() {
  const enabled = useGetSettingsValue('stagedSignupGrantEnabled');
  const signup = useGetSettingsValue('signupGrantCredits');
  const legacy = useGetSettingsValue('defaultFreeCredits');
  return Number(enabled ? signup : legacy) || 0;
}
