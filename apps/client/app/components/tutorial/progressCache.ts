import type { QueryClient } from '@tanstack/react-query';
import type { TutorialProgressEntry } from '@bike4mind/common';
import { tutorialProgressKey } from './tutorialKeys';
import type { TutorialTransport } from './types';

/**
 * Writes each saved position into the cached progress before the request lands, then refetches once it
 * has. Without it, finishing a module and landing on the start box in one click shows a Resume for it.
 */
export function trackedTransport(
  queryClient: QueryClient,
  base: TutorialTransport,
  apiBase: string
): TutorialTransport {
  const key = tutorialProgressKey(apiBase);
  return {
    ...base,
    position: async input => {
      queryClient.setQueryData<Record<string, TutorialProgressEntry>>(key, modules => {
        const entry = modules?.[input.moduleId];
        return entry
          ? { ...modules, [input.moduleId]: { ...entry, status: input.status, stepId: input.stepId } }
          : modules;
      });
      try {
        await base.position(input);
      } finally {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  };
}
