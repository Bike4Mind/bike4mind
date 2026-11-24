import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSelection, BillingAccount } from '@shared/account';

export interface AccountSelectionController {
  selection: AccountSelection | null;
  /** The account a pick is waiting on main for. */
  pending: string | null;
  /** Why the last read or pick failed; cleared by the next success. */
  error: string | null;
  select(account: BillingAccount): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Who pays for credit-spending calls, as main remembers it. Read from main's last answer on mount,
 * re-read fresh each time `refresh` turns true (the account menu opening) or an org-paid turn settles
 * (`spentAt` changes), and kept in step with picks made anywhere in the app.
 */
export function useAccountSelection(refresh = false, spentAt = 0): AccountSelectionController {
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback((fresh: boolean) => {
    window.b4m.account.getSelection(fresh).then(
      next => {
        if (!mounted.current) return;
        setSelection(next);
        setError(null);
      },
      (failure: unknown) => {
        if (mounted.current) setError(message(failure));
      }
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    load(false);
    const unsubscribe = window.b4m.account.onSelectionChanged(next => {
      if (mounted.current) setSelection(next);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [load]);

  useEffect(() => {
    if (refresh) load(true);
  }, [refresh, load]);

  // A settled turn may have drawn on an org pool, so its balance (and the avatar dot) is re-read.
  const paidByOrganization = selection?.selected ? !selection.selected.personal : false;
  useEffect(() => {
    if (spentAt > 0 && paidByOrganization) load(true);
  }, [spentAt, paidByOrganization, load]);

  const select = useCallback((account: BillingAccount) => {
    setPending(account.id);
    window.b4m.account.selectPayer(account.personal ? null : account.id).then(
      next => {
        if (!mounted.current) return;
        setSelection(next);
        setError(null);
        setPending(null);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setError(message(failure));
        setPending(null);
      }
    );
  }, []);

  return { selection, pending, error, select };
}
