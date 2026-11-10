import { useQuery } from '@tanstack/react-query';
import type { TutorialOwner } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { CORE_TUTORIALS_API_BASE } from '@client/app/components/tutorial/TutorialHostContext';

/** One of an owner's tutorials as its summary route lists it: no content, only what the tab shows. */
export interface TutorialOwnerSummaryRow {
  id: string;
  title: string;
  enabled: boolean;
}

/** The premium packages that contribute tutorials. Full admins only; the server is the enforced gate. */
export function useTutorialOwners() {
  return useQuery({
    queryKey: [CORE_TUTORIALS_API_BASE, 'tutorial', 'owners'],
    retry: false,
    queryFn: async () =>
      ((await api.get(`${CORE_TUTORIALS_API_BASE}/owners`)).data as { owners: TutorialOwner[] }).owners,
  });
}

/** One owner's tutorials, read from the owner's own summary route so a failing owner never blocks another. */
export function useTutorialOwnerSummary(adminBase: string) {
  return useQuery({
    queryKey: [adminBase, 'tutorial', 'owner-summary'],
    retry: false,
    queryFn: async () => (await api.get(`${adminBase}/summary`)).data as TutorialOwnerSummaryRow[],
  });
}
