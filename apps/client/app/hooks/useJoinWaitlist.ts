import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SubscriberSource } from '@bike4mind/common';

/**
 * Sends a visitor turned away by closed registration to the waitlist. The email rides in
 * history state rather than the query string so it never lands in URLs, logs or referrers.
 */
export const useJoinWaitlist = () => {
  const navigate = useNavigate();

  return useCallback(
    (source: SubscriberSource, email?: string) =>
      navigate({
        to: '/subscribe',
        search: { source },
        state: previous => ({ ...previous, waitlistEmail: email?.trim() || undefined }),
      }),
    [navigate]
  );
};
