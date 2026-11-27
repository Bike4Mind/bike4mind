import { useQuery } from '@tanstack/react-query';
import type { TutorialRunModule, TutorialRunModulesResponse, TutorialRunProgressResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { tutorialRunUrl } from '@client/app/components/tutorial/transport';
import { tutorialModulesKey, tutorialProgressKey } from '@client/app/components/tutorial/tutorialKeys';
import { useTutorialHostBase } from '@client/app/components/tutorial/hostBase';

/** The signed-in user's saved position in each module, keyed by module id. Reads the provider's host. */
export function useTutorialProgress(options: { enabled?: boolean; apiBase?: string } = {}) {
  const apiBase = useTutorialHostBase(options.apiBase);
  return useQuery({
    queryKey: tutorialProgressKey(apiBase),
    enabled: options.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.post<TutorialRunProgressResponse>(tutorialRunUrl(apiBase), { action: 'progress' });
      return data.modules;
    },
  });
}

/** The modules the signed-in user may run, as the host serves them. Reads the provider's host. */
export function useTutorialRunModules(options: { enabled?: boolean; apiBase?: string } = {}) {
  const apiBase = useTutorialHostBase(options.apiBase);
  return useQuery<TutorialRunModule[]>({
    queryKey: tutorialModulesKey(apiBase),
    enabled: options.enabled ?? true,
    queryFn: async () =>
      (await api.post<TutorialRunModulesResponse>(tutorialRunUrl(apiBase), { action: 'modules' })).data.modules,
  });
}
