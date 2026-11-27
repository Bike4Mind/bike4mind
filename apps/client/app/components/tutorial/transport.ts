import { api } from '@client/app/contexts/ApiContext';
import type { TutorialRunRequest, TutorialRunResponseByAction } from '@bike4mind/common';
import type { TutorialQuest, TutorialTransport } from './types';

/** The run route of a host's API base. Every transport call is one action on it. */
export const tutorialRunUrl = (apiBase: string) => `${apiBase}/run`;

export function createTutorialTransport(apiBase: string): TutorialTransport {
  const run = async <A extends TutorialRunRequest['action']>(
    request: Extract<TutorialRunRequest, { action: A }>
  ): Promise<TutorialRunResponseByAction[A]> =>
    (await api.post<TutorialRunResponseByAction[A]>(tutorialRunUrl(apiBase), request)).data;

  return {
    progress: async () => (await run({ action: 'progress' })).modules,
    start: input => run({ action: 'start', ...input }),
    resume: input => run({ action: 'resume', ...input }),
    sheet: input => run({ action: 'sheet', ...input }),
    // The route answers with the stored quest, so its id is always set.
    advance: async input => ({ quest: (await run({ action: 'advance', ...input })).quest as TutorialQuest }),
    position: async input => {
      await run({ action: 'position', ...input });
    },
  };
}
