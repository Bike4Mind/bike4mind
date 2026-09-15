import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Mementos V2 (the principal-scoped ledger) data hooks for the profile dashboard. V2 memory is a set
 * of BELIEFS folded from an append-only, encrypted ledger - not the editable rows V1 mementos are - so
 * the surface is read + shred, never edit (the ledger cannot be rewritten in place).
 */

/** One folded belief, minus its vector (the endpoint strips embeddings). */
export interface V2Belief {
  id: string; // the belief's subject (an HMAC); what a shred is keyed on
  fact: string;
  evidenceTier: string;
  confidence: number;
  salience?: 'hot' | 'warm' | 'cold';
  activation?: number;
  shredded?: boolean;
  derivedFrom: string[];
  lastAffirmedAt: string;
}

interface MemoryProfileResponse {
  profile: { principal: { kind: string; id: string }; beliefs: V2Belief[] };
}

const v2MemoryKey = (userId?: string) => ['memory-v2', userId] as const;

/** The current user's V2 belief set, most recently-affirmed first, shredded beliefs dropped. */
export function useV2Memory() {
  const { currentUser } = useUser();
  const userId = currentUser?.id;

  return useQuery({
    queryKey: v2MemoryKey(userId),
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data } = await api.get<MemoryProfileResponse>(`/api/memory/user/${userId}`);
      return data.profile.beliefs
        .filter(b => !b.shredded)
        .sort((a, b) => new Date(b.lastAffirmedAt).getTime() - new Date(a.lastAffirmedAt).getTime());
    },
  });
}

/**
 * Shred ONE belief - "delete this memory". Irreversible: it destroys the fact for that belief's ledger
 * events (the key and every OTHER belief survive). Keyed on the belief's id, which is its subject.
 */
export function useShredBelief() {
  const { currentUser } = useUser();
  const userId = currentUser?.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (beliefId: string) => {
      // Guard: a delete firing while auth is un-hydrated would POST to `/user/undefined` (the literal
      // string) and fail confusingly. Fail fast instead.
      if (!userId) throw new Error('Not signed in');
      const { data } = await api.delete<{ deleted: number }>(`/api/memory/user/${userId}`, {
        params: { subject: beliefId },
      });
      return data;
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: v2MemoryKey(userId) });
      // `deleted === 0` is a SUCCESSFUL HTTP call that shredded nothing (the belief matched neither the
      // ledger nor a memento). Surfacing it as a failure is what stops "delete forever" from silently
      // lying - the belief would otherwise just reappear on the refetch with no explanation.
      if (result.deleted === 0) {
        toast.error('That memory could not be deleted - please refresh and try again.');
      } else {
        toast.success('Memory deleted.');
      }
    },
    onError: () => {
      toast.error('Failed to delete that memory.');
    },
  });
}
