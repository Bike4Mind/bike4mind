import { api } from '@client/app/contexts/ApiContext';
import { IModalDocument } from '@bike4mind/common';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { useRef } from 'react';
import { useUser } from '@client/app/contexts/UserContext';

const getErrorStatus = (error: unknown): number | undefined =>
  isAxiosError(error) ? error.response?.status : undefined;

interface UseGetModalsOptions {
  /** When true, excludes modals with 'whats-new' tag (used by admin Modals Management page) */
  excludeWhatsNew?: boolean;
}

export function useGetModals(options?: UseGetModalsOptions) {
  const hasShownError = useRef(false);
  const excludeWhatsNew = options?.excludeWhatsNew ?? false;
  const currentUser = useUser(s => s.currentUser);

  const query = useQuery({
    queryKey: ['modals', { excludeWhatsNew }],
    enabled: !!currentUser,
    queryFn: async () => {
      try {
        const { data } = await api.get<IModalDocument[]>(`/api/modals?excludeWhatsNew=${excludeWhatsNew}`);
        hasShownError.current = false; // Reset error flag on success
        return data;
      } catch (error) {
        // A 401 is session-expiry, owned entirely by the ApiContext response
        // interceptor (token refresh -> redirect to /login with its own
        // session_expired toast). Surfacing a "notifications" error here would
        // just flash misleading noise for the instant before the page unloads
        // to the login screen. Only toast for genuine failures (5xx, network).
        if (getErrorStatus(error) !== 401 && !hasShownError.current) {
          // Only show error toast once to avoid spam
          console.error('Failed to fetch modals:', error);
          toast.error('Unable to load notifications. Please refresh the page.');
          hasShownError.current = true;
        }
        throw error;
      }
    },
    staleTime: 1000 * 60 * 2, // 2 minutes - balance between freshness and performance
    refetchOnMount: true, // Default (respects staleTime)
    // Don't retry auth failures: the interceptor already performs one
    // refresh+retry, so re-running the query on a 401 only burns exponential
    // backoff before the inevitable redirect. Retry other failures up to 3x.
    retry: (failureCount, error) => getErrorStatus(error) !== 401 && failureCount < 3,
    retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
  });

  return query;
}
