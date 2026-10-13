import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import debounce from 'lodash/debounce';
import { useEffect, useMemo } from 'react';

export const INVITE_REFETCH_DEBOUNCE_MS = 250;
export const INVITE_REFETCH_MAX_WAIT_MS = 1000;

/**
 * Returns a debounced invalidate of `queryKey`, so a burst of subscription events (each (re)subscribe
 * replays one event per document in scope) costs one refetch. maxWait keeps a steady stream from
 * deferring it indefinitely; a pending call is cancelled on unmount or key change.
 * The key must be JSON-serializable: it is compared by value, so an inline array literal is fine.
 */
export const useCoalescedInvalidate = (queryKey: QueryKey) => {
  const queryClient = useQueryClient();
  const serializedKey = JSON.stringify(queryKey);

  const invalidate = useMemo(
    () =>
      debounce(
        () => queryClient.invalidateQueries({ queryKey: JSON.parse(serializedKey) as QueryKey }),
        INVITE_REFETCH_DEBOUNCE_MS,
        { maxWait: INVITE_REFETCH_MAX_WAIT_MS }
      ),
    [queryClient, serializedKey]
  );

  useEffect(() => () => invalidate.cancel(), [invalidate]);

  return invalidate;
};
