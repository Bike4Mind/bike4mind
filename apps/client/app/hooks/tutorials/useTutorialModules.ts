import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OverrideUnit, ValidationIssue } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { TutorialModulesResponse } from '@client/app/components/tutorial/admin/adminTypes';
import { tutorialAdminModulesKey, tutorialModulesKey } from '@client/app/components/tutorial/tutorialKeys';

const overridesUrl = (apiBase: string) => `${apiBase}/overrides`;

const fetchModules = async (apiBase: string) => (await api.get(overridesUrl(apiBase))).data as TutorialModulesResponse;

/** Admin hooks for a host's tutorial switch and live edits. The server is the enforced admin gate. */
export function useTutorialModules(apiBase: string) {
  return useQuery({
    queryKey: tutorialAdminModulesKey(apiBase),
    retry: false,
    queryFn: () => fetchModules(apiBase),
    select: data => data.modules,
  });
}

export function useTutorialAnchorChoices(apiBase: string) {
  return useQuery({
    queryKey: tutorialAdminModulesKey(apiBase),
    retry: false,
    queryFn: () => fetchModules(apiBase),
    select: data => data.choices,
  });
}

function useAfterSave(apiBase: string) {
  const queryClient = useQueryClient();
  return (data: TutorialModulesResponse) => {
    queryClient.setQueryData(tutorialAdminModulesKey(apiBase), data);
    // The admin's own start points and running tutorial follow without a reload.
    void queryClient.invalidateQueries({ queryKey: tutorialModulesKey(apiBase) });
  };
}

export function useSetTutorialModule(apiBase: string) {
  const afterSave = useAfterSave(apiBase);
  return useMutation({
    mutationFn: async (input: { moduleId: string; enabled: boolean; reason: string }) =>
      (await api.put(overridesUrl(apiBase), input)).data as TutorialModulesResponse,
    onSuccess: (data, input) => {
      afterSave(data);
      toast.success(`${input.moduleId} tutorial ${input.enabled ? 'on' : 'off'}`);
    },
    onError: () => toast.error('Could not save the tutorial module switch'),
  });
}

/** What a refused save said: the rules it broke, so the editor can show them beside the fields. */
export class TutorialEditRefused extends Error {
  constructor(
    message: string,
    readonly rules: ValidationIssue[],
    /** Someone else saved the module since this draft began, so the draft must be reloaded. */
    readonly conflict = false
  ) {
    super(message);
  }
}

export function useSaveTutorialEdits(apiBase: string) {
  const afterSave = useAfterSave(apiBase);
  return useMutation({
    mutationFn: async (input: {
      moduleId: string;
      fields: OverrideUnit[];
      reason: string;
      expectedContentSeq: number | null;
    }) => {
      try {
        return (await api.put(overridesUrl(apiBase), input)).data as TutorialModulesResponse;
      } catch (error) {
        const response = (
          error as { response?: { status?: number; data?: { error?: string; rules?: ValidationIssue[] } } }
        ).response;
        if (response?.status === 422 || response?.status === 409) {
          throw new TutorialEditRefused(
            response.data?.error ?? 'The edit was refused',
            response.data?.rules ?? [],
            response.status === 409
          );
        }
        throw error;
      }
    },
    onSuccess: (data, input) => {
      afterSave(data);
      toast.success(
        input.fields.length === 0 ? `${input.moduleId} reset to the repo` : `${input.moduleId} edits saved`
      );
    },
    onError: error => {
      if (!(error instanceof TutorialEditRefused)) toast.error('Could not save the tutorial edits');
    },
  });
}
