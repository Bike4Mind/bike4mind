import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SECURITY_DASHBOARD_PROWLER_QUERY_KEY,
  useRunProwlerScan,
  useSecurityDashboardProwler,
  type SecurityDashboardProwlerSnapshot,
} from '@client/app/hooks/data/admin';
import { useSecurityScanCooldown } from '@client/app/hooks/useSecurityScanCooldown';

type RequestState =
  | { kind: 'idle'; error: string | null }
  | { kind: 'pending'; baseline: number | null }
  | { kind: 'queued'; baseline: number | null };

type ProwlerScanRequest = {
  pending: boolean;
  queued: boolean;
  error: string | null;
  start: () => void;
};

const RequestContext = createContext<ProwlerScanRequest | null>(null);

function checkedAt(snapshot: SecurityDashboardProwlerSnapshot | null | undefined): number | null {
  const timestamp = Date.parse(snapshot?.checkedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** One dashboard-lifetime request owner, shared by the summary and detail controls. */
export function ProwlerScanRequestProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const snapshot = useSecurityDashboardProwler();
  const mutation = useRunProwlerScan();
  const { cooldownActive } = useSecurityScanCooldown(snapshot.data?.checkedAt);
  const [state, setState] = useState<RequestState>({ kind: 'idle', error: null });
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
    const query = queryClient.getQueryState<SecurityDashboardProwlerSnapshot | null>(
      SECURITY_DASHBOARD_PROWLER_QUERY_KEY
    );
    // Cached data retained after a failed refetch is not a newly successful audit.
    if (query?.status !== 'success') return;
    const timestamp = checkedAt(query.data);
    if (timestamp !== null && (request.baseline === null || timestamp > request.baseline)) {
      transition({ kind: 'idle', error: null });
    }
  }, [queryClient, transition]);

  useEffect(releaseOnNewResult, [releaseOnNewResult, snapshot.data, snapshot.dataUpdatedAt, snapshot.status]);

  const start = useCallback(() => {
    if (!mounted.current || current.current.kind !== 'idle' || cooldownActive || snapshot.data === undefined) return;
    const baseline = checkedAt(
      queryClient.getQueryData<SecurityDashboardProwlerSnapshot | null>(SECURITY_DASHBOARD_PROWLER_QUERY_KEY)
    );
    transition({ kind: 'pending', baseline });
    mutation.mutate(undefined, {
      onSuccess: response => {
        if (!mounted.current) return;
        if (response.queued !== true) {
          const error = 'Prowler scan was not queued.';
          transition({ kind: 'idle', error });
          toast.error(error);
          return;
        }
        transition({ kind: 'queued', baseline });
        toast.success('Prowler scan queued. Results arrive in about 10 minutes.');
        // A fresh result can arrive while the POST is still awaiting acknowledgement.
        releaseOnNewResult();
      },
      onError: () => {
        if (!mounted.current) return;
        const error = 'Failed to queue Prowler scan. Check that SECOPS_PROWLER_WORKFLOW_TOKEN is configured.';
        transition({ kind: 'idle', error });
        toast.error(error);
      },
    });
  }, [cooldownActive, mutation, queryClient, releaseOnNewResult, snapshot.data, transition]);

  return (
    <RequestContext.Provider
      value={{
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

export function useProwlerScanRequest(): ProwlerScanRequest {
  const request = useContext(RequestContext);
  if (!request) throw new Error('Prowler scan controls require their dashboard request provider');
  return request;
}
