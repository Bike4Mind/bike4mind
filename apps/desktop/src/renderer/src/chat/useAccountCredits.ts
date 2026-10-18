import { useCallback, useEffect, useState } from 'react';
import type { AccountCredits } from '@shared/account';

/**
 * The account's credit balance for the composer's usage line.
 *
 * Read on mount and again whenever `spentAt` changes - the caller ticks it when a turn ends,
 * which is the only moment this client knows the balance can have moved. Deliberately NOT
 * polled: a timer would cost a request an interval forever to watch a number that changes when
 * the user does something this window already witnesses.
 *
 * The cost of that choice is a balance spent from another client - the web app, another
 * desktop conversation - which this window keeps showing until its own next turn ends. That is
 * the trade a poll would buy back, and it is not worth a standing request.
 */
export function useAccountCredits(spentAt: number): AccountCredits {
  const [credits, setCredits] = useState<AccountCredits>({ balance: null });

  const refresh = useCallback(() => {
    let current = true;
    void window.b4m.account.getCredits().then(next => {
      if (current) setCredits(next);
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(refresh, [refresh, spentAt]);

  return credits;
}
