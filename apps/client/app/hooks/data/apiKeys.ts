import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAPIKeysFromServer, upsertApiKey } from '@client/app/utils/keyAPICalls';
import { ApiKeyType, IApiKeyDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

/**
 * A personal key changes more than the key list: serverConfig.toolAvailability resolves each
 * key-gated tool from the user's own key first (resolveToolAvailability), and useConfig caches it
 * for minutes without a focus refetch, so a just-saved key would leave its tools greyed out.
 */
const invalidateKeyDependentQueries = (queryClient: QueryClient) => {
  queryClient.invalidateQueries({ queryKey: ['api-keys'] });
  queryClient.invalidateQueries({ queryKey: ['server-config'] });
};

export function useGetAllApiKeys() {
  return useQuery({ queryKey: ['api-keys'], queryFn: () => getAPIKeysFromServer() });
}

export function useSetActiveApiKey(type: string = ApiKeyType.openai) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/api/api-keys/${id}/set-active`, { type })).data,
    onSuccess: () => {
      invalidateKeyDependentQueries(queryClient);
    },
  });
}

export function useAddNewApiKey({ onSuccess }: { onSuccess?: () => void }) {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, { apiKey: string; type: string; description: string; isActive: boolean }>({
    mutationFn: data => upsertApiKey(data),
    onSuccess: () => {
      invalidateKeyDependentQueries(queryClient);
      if (onSuccess) onSuccess();
    },
  });
}

export function useDeleteApiKey({ onSuccess }: { onSuccess?: () => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/api-keys/${id}/delete`)).data,
    onSuccess: (result: IApiKeyDocument) => {
      const data = queryClient.getQueryData(['api-keys']);
      const newData = (data as IApiKeyDocument[]).filter(d => d.id !== result.id);
      queryClient.setQueryData(['api-keys'], newData);

      invalidateKeyDependentQueries(queryClient);

      if (onSuccess) onSuccess();
    },
  });
}
