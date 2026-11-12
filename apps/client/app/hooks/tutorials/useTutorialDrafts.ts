import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import type { TutorialDraftsResponse, ValidationIssue } from '@bike4mind/common';
import { tutorialDraftsKey, tutorialModulesKey } from '@client/app/components/tutorial/tutorialKeys';

const draftsUrl = (apiBase: string) => `${apiBase}/drafts`;

export type TutorialDraftAction = { action: string; moduleId: string } & Record<string, unknown>;

/** What a refused action said, so the card can show the rules beside the draft. */
export class TutorialDraftRefused extends Error {
  constructor(
    message: string,
    readonly rules: ValidationIssue[],
    readonly code?: string
  ) {
    super(message);
  }
}

/** Admin hooks for modules made from a captured session. The server is the enforced admin gate. */
export function useTutorialDrafts(apiBase: string) {
  return useQuery({
    queryKey: tutorialDraftsKey(apiBase),
    retry: false,
    queryFn: async () => (await api.get(draftsUrl(apiBase))).data as TutorialDraftsResponse,
  });
}

export function useTutorialDraftAction(apiBase: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TutorialDraftAction) => {
      try {
        return (await api.post(draftsUrl(apiBase), input)).data as TutorialDraftsResponse;
      } catch (error) {
        const response = (
          error as {
            response?: { status?: number; data?: { error?: string; code?: string; rules?: ValidationIssue[] } };
          }
        ).response;
        if (response?.status && response.status >= 400 && response.status < 500) {
          throw new TutorialDraftRefused(
            response.data?.error ?? 'The change was refused',
            response.data?.rules ?? [],
            response.data?.code
          );
        }
        throw error;
      }
    },
    onSuccess: (data, input) => {
      queryClient.setQueryData(tutorialDraftsKey(apiBase), data);
      void queryClient.invalidateQueries({ queryKey: tutorialModulesKey(apiBase) });
      toast.success(`${input.moduleId}: ${input.action} done`);
    },
    onError: error => {
      toast.error(error instanceof TutorialDraftRefused ? error.message : 'Could not change the tutorial draft');
    },
  });
}
