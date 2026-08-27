import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/** A registry prompt a session (and therefore a data lake) may activate, as shown in a picker. */
export interface ActivatablePrompt {
  promptId: string;
  name: string;
  description: string;
}

/**
 * The registry prompts a data lake may bind as its preferred session prompt
 * (GET /api/system-prompts/activatable - the server-owned session-activatable allowlist).
 *
 * The list changes only when the allowlist does (a deploy), so it is cached long and never
 * refetched on focus. `enabled` lets a caller defer the fetch until the picker is actually shown.
 */
export function useActivatablePrompts(enabled = true) {
  return useQuery({
    queryKey: ['system-prompts', 'activatable'],
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: ActivatablePrompt[] }>('/api/system-prompts/activatable');
      return response.data.data;
    },
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
