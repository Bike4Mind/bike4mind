import { useEffect, useState } from 'react';
import { isCancelledError, useIsFetching, useQueryClient } from '@tanstack/react-query';
import { userQueryKey } from '@client/app/hooks/data/user';

export type UserRefresh = { refreshing: boolean; failed: boolean };

export const BALANCE_REFRESH_FAILED = 'The current balance could not be loaded. Close and reopen to try again.';

/**
 * Refetches the profile (`useGetUser`, cached for minutes) when a dialog that does arithmetic on the
 * balance opens, so its preview and undo start from the server's figure. The new user arrives through
 * the dialog's `user` prop. A failed read keeps the cached user, so callers block on `failed`.
 */
export const useRefreshedUser = (userId: string): UserRefresh => {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setFailed(false);
    queryClient
      .refetchQueries({ queryKey: userQueryKey(userId), exact: true }, { throwOnError: true })
      // A cancelled read was superseded by another refetch, which `refreshing` already tracks.
      .catch((error: unknown) => {
        if (current && !isCancelledError(error)) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [queryClient, userId]);
  const refreshing = useIsFetching({ queryKey: userQueryKey(userId), exact: true }) > 0;
  return { refreshing, failed };
};
