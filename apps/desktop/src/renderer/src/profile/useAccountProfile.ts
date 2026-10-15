import { useEffect, useState } from 'react';
import type { AccountProfile } from '@shared/account';

/** The account's balance and plan, read once when the screen opens. */
export function useAccountProfile(attempt: number): AccountProfile | null {
  const [profile, setProfile] = useState<AccountProfile | null>(null);

  useEffect(() => {
    let current = true;
    void window.b4m.account.getProfile().then(next => {
      if (current) setProfile(next);
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  return profile;
}
