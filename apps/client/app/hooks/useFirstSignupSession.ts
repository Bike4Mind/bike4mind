import { useMemo } from 'react';
import { isFirstSignupSession } from '@client/app/utils/firstSignupSession';

export function useFirstSignupSession(userId: string | undefined): boolean {
  return useMemo(() => isFirstSignupSession(userId), [userId]);
}
