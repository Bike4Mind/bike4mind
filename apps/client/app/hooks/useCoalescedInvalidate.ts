import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import debounce from 'lodash/debounce';
import { useEffect, useMemo } from 'react';

export const COALESCED_INVALIDATE_DEBOUNCE_MS = 250;
export const COALESCED_INVALIDATE_MAX_WAIT_MS = 1000;

/**
 * Returns a debounced invalidate of `queryKey`, so a burst of subscription events (each (re)subscribe
 * replays one event per document in scope) costs one refetch. maxWait keeps a steady stream from
 * deferring it indefinitely; a pending call is cancelled on unmount or key change.
 * The key is compared by value (its JSON form) to keep the debounce stable, so an inline array literal
 * is fine; the invalidate itself uses the caller's original key, never a round-tripped copy.
 */
export const useCoalescedInvalidate = (queryKey: QueryKey) => {
  const queryClient = useQueryClient();
  const serializedKey = JSON.stringify(queryKey);

  const invalidate = useMemo(
    () =>
      debounce(() => queryClient.invalidateQueries({ queryKey }), COALESCED_INVALIDATE_DEBOUNCE_MS, {
        maxWait: COALESCED_INVALIDATE_MAX_WAIT_MS,
      }),
    // serializedKey is the identity: an equal inline key keeps this debounce, a new key value gets a fresh one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, serializedKey]
  );

  useEffect(() => () => invalidate.cancel(), [invalidate]);

  return invalidate;
};
