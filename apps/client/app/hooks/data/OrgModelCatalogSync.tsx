import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken, useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';
import { useSelectedAccount } from '@client/app/components/Credits/selectedAccountStore';
import { orgIdOfAccount } from '@client/app/components/datalake/lakeSourceShared';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import { catalogQueryKey } from './useModelInfo';

function policyFingerprint(value: unknown): string | undefined {
  try {
    return (
      JSON.stringify(value ?? null, (_key, current: unknown) => {
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          return Object.fromEntries(
            Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
          );
        }
        return current;
      }) ?? 'null'
    );
  } catch (error) {
    console.error('Could not compare the organization model policy; refreshing its catalog', error);
    return undefined;
  }
}

function OrgModelCatalogSubscription({ userId, orgId }: { userId: string; orgId: string }) {
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  const fingerprint = useRef<string | undefined>(undefined);
  const queued = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onOrganization = useCallback(
    (operation: string, data: unknown) => {
      const isCurrent = () => {
        const session = useAccessToken.getState();
        return (
          mounted.current &&
          !!session.accessToken &&
          !session.mfaPending &&
          useUser.getState().currentUser?.id === userId &&
          orgIdOfAccount(useSelectedAccount.getState().selectedAccount) === orgId
        );
      };
      if (!isCurrent() || !data || typeof data !== 'object' || Array.isArray(data)) return;
      if (!['insert', 'update', 'replace', 'delete'].includes(operation)) return;
      const document = data as Record<string, unknown>;
      if (document.id !== undefined && document.id !== orgId) return;
      if (document._id !== undefined && document._id !== orgId) return;
      if (document.id !== orgId && document._id !== orgId) return;
      if (operation === 'delete') {
        fingerprint.current = undefined;
      } else {
        const next = policyFingerprint(document.modelPolicy);
        // An insert is also the initial/reconnect/reauth replay, so it always closes a missed-event gap.
        if (next !== undefined && operation !== 'insert' && next === fingerprint.current) return;
        fingerprint.current = next;
      }
      generation.current += 1;
      if (queued.current) return;
      queued.current = true;
      queueMicrotask(() => {
        queued.current = false;
        const currentGeneration = generation.current;
        const refresh = async () => {
          if (!isCurrent()) return;
          try {
            const queryKey = catalogQueryKey(orgId);
            await queryClient.cancelQueries({ queryKey, exact: true });
            if (!isCurrent() || generation.current !== currentGeneration) return;
            await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'active' });
          } catch (error) {
            console.error('Could not refresh the organization model catalog', error);
          }
        };
        void refresh();
      });
    },
    [queryClient, userId, orgId]
  );

  useSubscribeCollection('organizations', { _id: orgId }, onOrganization, {
    fetchInitialData: true,
    initialDataAfterSubscribe: true,
  });
  return null;
}

/** One authorized listener per selected account, independent of the number of catalog consumers. */
export function OrgModelCatalogSync() {
  const authenticated = useIsFullyAuthenticated();
  const userId = useUser(state => state.currentUser?.id);
  const orgId = useSelectedAccount(state => orgIdOfAccount(state.selectedAccount));
  if (!authenticated || !userId || !orgId) return null;
  // Remounting changes the wire subscription id, including A -> B -> A and same-org user switches.
  return <OrgModelCatalogSubscription key={JSON.stringify([userId, orgId])} userId={userId} orgId={orgId} />;
}
