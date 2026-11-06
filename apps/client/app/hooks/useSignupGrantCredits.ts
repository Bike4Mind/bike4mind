import { useSignupGrantSchedule } from './useSignupGrantSchedule';

export function useSignupGrantCredits() {
  return useSignupGrantSchedule().initialCredits;
}
