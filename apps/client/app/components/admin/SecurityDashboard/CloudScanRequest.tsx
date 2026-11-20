import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SECURITY_DASHBOARD_CLOUD_QUERY_KEY,
  useRunCloudSecurityScan,
  useSecurityDashboardCloud,
  type SecurityDashboardCloudSnapshot,
} from '@client/app/hooks/data/admin';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';

type RequestState =
  | { kind: 'idle'; error: string | null }
  | { kind: 'pending'; baseline: number | null }
  | { kind: 'queued'; baseline: number | null };

type CloudScanRequest = {
  cooldown: ReturnType<typeof useSecurityScanCooldown>;
  loading: boolean;
  pending: boolean;
  queued: boolean;
  error: string | null;
  start: () => void;
};

const RequestContext = createContext<CloudScanRequest | null>(null);

// Outlasts the worker's 5-minute timeout plus Lambda's two async retries; a run still silent after
// this has gone to the cloud-security-scan DLQ, so stop polling for it.
export const QUEUED_RESULT_DEADLINE_MS = 20 * 60 * 1000;
export const QUEUED_RESULT_TIMEOUT_ERROR =
  'Cloud baseline scan did not report a result in time. Check the scan dead-letter queue before retrying.';

function checkedAt(snapshot: SecurityDashboardCloudSnapshot | null | undefined): number | null {
  const timestamp = Date.parse(snapshot?.checkedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** One dashboard-lifetime request owner, shared by the summary and detail controls. */
export function CloudScanRequestProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RequestState>({ kind: 'idle', error: null });
  const snapshot = useSecurityDashboardCloud(state.kind === 'queued' ? 10_000 : false);
  const mutation = useRunCloudSecurityScan();
  const cooldown = useSecurityScanCooldown(snapshot.data?.checkedAt);
  const { cooldownActive } = cooldown;
  const current = useRef<RequestState>(state);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const transition = useCallback((next: RequestState) => {
    if (!mounted.current) return;
    // Claim synchronously: connected clicks can arrive before React publishes the pending render.
    current.current = next;
    setState(next);
  }, []);

  const releaseOnNewResult = useCallback(() => {
    const request = current.current;
    if (request.kind !== 'queued') return;
    const query = queryClient.getQueryState<SecurityDashboardCloudSnapshot | null>(SECURITY_DASHBOARD_CLOUD_QUERY_KEY);
    // Cached data retained after a failed refetch is not a newly successful audit.
    if (query?.status !== 'success') return;
    const timestamp = checkedAt(query.data);
    if (timestamp !== null && (request.baseline === null || timestamp > request.baseline)) {
      transition({ kind: 'idle', error: null });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'security-dashboard', 'overview'] });
    }
  }, [queryClient, transition]);

  useEffect(releaseOnNewResult, [releaseOnNewResult, snapshot.data, snapshot.dataUpdatedAt, snapshot.status]);

  useEffect(() => {
    if (state.kind !== 'queued') return;
    const timer = setTimeout(() => {
      if (current.current !== state) return;
      transition({ kind: 'idle', error: QUEUED_RESULT_TIMEOUT_ERROR });
      toast.error(QUEUED_RESULT_TIMEOUT_ERROR);
    }, QUEUED_RESULT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [state, transition]);

  const start = useCallback(() => {
    if (!mounted.current || current.current.kind !== 'idle' || cooldownActive || snapshot.isLoading) return;
    const baseline = checkedAt(
      queryClient.getQueryData<SecurityDashboardCloudSnapshot | null>(SECURITY_DASHBOARD_CLOUD_QUERY_KEY)
    );
    transition({ kind: 'pending', baseline });
    mutation.mutate(undefined, {
      onSuccess: response => {
        if (!mounted.current) return;
        if (response.queued !== true) {
          const error = 'Cloud baseline scan was not queued.';
          transition({ kind: 'idle', error });
          toast.error(error);
          return;
        }
        transition({ kind: 'queued', baseline });
        toast.success('Cloud baseline scan queued. Results appear here when it finishes.');
        // A fresh result can arrive while the POST is still awaiting acknowledgement.
        releaseOnNewResult();
      },
      onError: () => {
        if (!mounted.current) return;
        const error = 'Failed to queue cloud baseline scan.';
        transition({ kind: 'idle', error });
        toast.error(error);
      },
    });
  }, [cooldownActive, mutation, queryClient, releaseOnNewResult, snapshot.isLoading, transition]);

  return (
    <RequestContext.Provider
      value={{
        cooldown,
        loading: snapshot.isLoading,
        pending: state.kind === 'pending' || mutation.isPending,
        queued: state.kind === 'queued',
        error: state.kind === 'idle' ? state.error : null,
        start,
      }}
    >
      {children}
    </RequestContext.Provider>
  );
}

export function useCloudScanRequest(): CloudScanRequest {
  const request = useContext(RequestContext);
  if (!request) throw new Error('Cloud scan controls require their dashboard request provider');
  return request;
}
