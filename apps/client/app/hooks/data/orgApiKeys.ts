import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IOrgApiKeySecretResponse, IOrgApiKeyView, IOrgMemberApiKeyView } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

/** Org-owned API keys (pages/api/organizations/[id]/api-keys). */
const orgApiKeysQueryKey = (organizationId: string) => ['organizations', organizationId, 'api-keys'] as const;

/** Members' org-billed keys (pages/api/organizations/[id]/api-keys/members). */
const orgMemberApiKeysQueryKey = (organizationId: string) =>
  ['organizations', organizationId, 'api-keys', 'members'] as const;

const errorMessage = (error: unknown, fallback: string): string => {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } }).response?.data;
  const message = data?.error ?? data?.message;
  return typeof message === 'string' && message ? message : fallback;
};

export function useOrgApiKeys(organizationId: string) {
  return useQuery<IOrgApiKeyView[]>({
    queryKey: orgApiKeysQueryKey(organizationId),
    queryFn: async () => {
      const response = await api.get(`/api/organizations/${organizationId}/api-keys`, {
        params: { includeDisabled: true },
      });
      return response.data;
    },
  });
}

export type CreateOrgApiKeyRequest = { name: string; scopes: string[]; expiresAt?: string };

export function useCreateOrgApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<IOrgApiKeySecretResponse, unknown, CreateOrgApiKeyRequest>({
    mutationFn: async body => (await api.post(`/api/organizations/${organizationId}/api-keys`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgApiKeysQueryKey(organizationId) }),
    onError: error => toast.error(errorMessage(error, 'Failed to create the API key')),
  });
}

export function useRotateOrgApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<IOrgApiKeySecretResponse, unknown, string>({
    mutationFn: async keyId => (await api.post(`/api/organizations/${organizationId}/api-keys/${keyId}/rotate`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgApiKeysQueryKey(organizationId) }),
    onError: error => toast.error(errorMessage(error, 'Failed to rotate the API key')),
  });
}

export function useRevokeOrgApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async keyId => {
      await api.post(`/api/organizations/${organizationId}/api-keys/${keyId}/revoke`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgApiKeysQueryKey(organizationId) }),
    onError: error => toast.error(errorMessage(error, 'Failed to revoke the API key')),
  });
}

export function useOrgMemberApiKeys(organizationId: string) {
  return useQuery<IOrgMemberApiKeyView[]>({
    queryKey: orgMemberApiKeysQueryKey(organizationId),
    queryFn: async () => (await api.get(`/api/organizations/${organizationId}/api-keys/members`)).data,
  });
}

export function useRevokeOrgMemberApiKey(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: async keyId => {
      await api.post(`/api/organizations/${organizationId}/api-keys/members/${keyId}/revoke`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgMemberApiKeysQueryKey(organizationId) }),
    onError: error => toast.error(errorMessage(error, 'Failed to revoke the API key')),
  });
}
