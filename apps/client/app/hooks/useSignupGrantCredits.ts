import { useGetSettingsValue } from './data/settings';

export function useSignupGrantCredits() {
  const enabled = useGetSettingsValue('stagedSignupGrantEnabled');
  const signup = useGetSettingsValue('signupGrantCredits');
  const legacy = useGetSettingsValue('defaultFreeCredits');
  return Number(enabled === true || enabled === 'true' ? signup : legacy) || 0;
}
