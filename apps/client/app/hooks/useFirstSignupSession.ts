import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  FIRST_SIGNUP_SESSION_KEY,
  isFirstSignupSession,
  readFirstSignupSession,
} from '@client/app/utils/firstSignupSession';

export function useFirstSignupSession(userId: string | undefined): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === FIRST_SIGNUP_SESSION_KEY) onChange();
      };
      window.addEventListener('storage', onStorage);
      const { active, expiresAt } = readFirstSignupSession(userId);
      const timer =
        active && expiresAt !== undefined ? setTimeout(onChange, Math.max(0, expiresAt - Date.now())) : undefined;
      return () => {
        window.removeEventListener('storage', onStorage);
        if (timer !== undefined) clearTimeout(timer);
      };
    },
    [userId]
  );
  const getSnapshot = useCallback(() => readFirstSignupSession(userId).active, [userId]);
  const active = useSyncExternalStore(subscribe, getSnapshot, () => false);

  useEffect(() => {
    if (userId && !active) isFirstSignupSession(userId);
  }, [userId, active]);

  return active;
}
