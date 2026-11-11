import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { tutorialSwitchKey } from '@client/app/components/tutorial/tutorialKeys';
import { ADMIN_SETTINGS_ARRAY_QUERY_KEY } from '@client/app/hooks/data/queryKeys';

const settingsUrl = (apiBase: string) => `${apiBase}/settings`;

/** Admin hooks for a host's guided tutorials switch. The server is the enforced admin gate. */
export function useTutorialsSwitch(apiBase: string) {
  return useQuery({
    queryKey: tutorialSwitchKey(apiBase),
    retry: false,
    queryFn: async () => ((await api.get(settingsUrl(apiBase))).data as { enabled: boolean }).enabled,
  });
}

export function useSetTutorialsSwitch(apiBase: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      ((await api.put(settingsUrl(apiBase), { enabled })).data as { enabled: boolean }).enabled,
    onSuccess: enabled => {
      queryClient.setQueryData(tutorialSwitchKey(apiBase), enabled);
      // useTutorialsEnabled reads the settings list, so the start points follow without a reload.
      void queryClient.invalidateQueries({ queryKey: ADMIN_SETTINGS_ARRAY_QUERY_KEY });
      toast.success(enabled ? 'Guided tutorials on' : 'Guided tutorials off');
    },
    onError: () => toast.error('Could not save the tutorials switch'),
  });
}
