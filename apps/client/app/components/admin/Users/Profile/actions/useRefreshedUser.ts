import { useEffect } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';

/**
 * Refetches the profile (`useGetUser`'s `['users', id]`, cached for minutes) when a dialog that does
 * arithmetic on the balance opens, so its preview and undo start from the server's figure. The new
 * user arrives through the dialog's `user` prop. Returns true while that read is in flight.
 */
export const useRefreshedUser = (userId: string): boolean => {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.refetchQueries({ queryKey: ['users', userId], exact: true });
  }, [queryClient, userId]);
  return useIsFetching({ queryKey: ['users', userId], exact: true }) > 0;
};
