import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IUserApiKeyDocument, ApiKeyScope } from '@bike4mind/common';
import { toast } from 'sonner';

function parseValidationError(error: any): string {
  const errorMessage = error.response?.data?.error;

  if (typeof errorMessage === 'string' && errorMessage.includes(':')) {
    // Parse multiple validation errors separated by commas
    return errorMessage
      .split(', ')
      .map((msg: string) => {
        const [field, ...messageParts] = msg.split(': ');
        console.log(field, messageParts);
        const message = messageParts.join(': ');

        // Format field names nicely (e.g., "rateLimit.requestsPerMinute" -> "Rate limit requests per minute")
        const formattedField = field
          .split('.')
          .map(part => part.replace(/([A-Z])/g, ' $1').toLowerCase())
          .join(' ')
          .replace(/^\w/, c => c.toUpperCase());

        return `${formattedField}: ${message}`;
      })
      .join('\n');
  }

  return errorMessage || error.message || 'An error occurred';
}

export interface CreateUserApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  expiresAt?: Date;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  /** When set, mint an org-billed key charging this organization's credit pool. */
  organizationId?: string;
}

/** An organization the current user may bill API-key usage to. */
export interface BillingOrganization {
  id: string;
  name: string;
}

export interface CreateUserApiKeyResponse extends IUserApiKeyDocument {
  key: string; // Only returned once during creation
}

export interface RotateUserApiKeyResponse {
  id: string;
  name: string;
  keyPrefix: string;
  key: string; // Only returned once during rotation
}

export function useGetUserApiKeys() {
  return useQuery<IUserApiKeyDocument[]>({
    queryKey: ['user-api-keys'],
    queryFn: async () => {
      const response = await api.get('/api/user-api-keys');
      return response.data;
    },
  });
}

export function useBillingOrganizations() {
  return useQuery<BillingOrganization[]>({
    queryKey: ['user-api-keys', 'billing-organizations'],
    queryFn: async () => {
      const response = await api.get('/api/user-api-keys/billing-organizations');
      return response.data;
    },
  });
}

export function useCreateUserApiKey({ onSuccess }: { onSuccess?: (result: CreateUserApiKeyResponse) => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation<CreateUserApiKeyResponse, Error, CreateUserApiKeyRequest>({
    mutationFn: async data => {
      const response = await api.post('/api/user-api-keys', data);
      return response.data;
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      if (onSuccess) onSuccess(result);
    },
    onError: (error: Error) => {
      toast.error(parseValidationError(error));
    },
  });
}

export function useRotateUserApiKey({ onSuccess }: { onSuccess?: (result: RotateUserApiKeyResponse) => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation<RotateUserApiKeyResponse, Error, string>({
    mutationFn: async keyId => {
      const response = await api.post(`/api/user-api-keys/${keyId}/rotate`);
      return response.data;
    },
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      if (onSuccess) onSuccess(result);
    },
  });
}

export function useAdminGenerateApiKey({ onSuccess }: { onSuccess?: (result: CreateUserApiKeyResponse) => void } = {}) {
  return useMutation<CreateUserApiKeyResponse, Error, { userId: string; data: CreateUserApiKeyRequest }>({
    mutationFn: async ({ userId, data }) => {
      const response = await api.post(`/api/admin/users/${userId}/generate-api-key`, data);
      return response.data;
    },
    onSuccess: result => {
      if (onSuccess) onSuccess(result);
    },
    onError: (error: Error) => {
      toast.error(parseValidationError(error));
    },
  });
}

export function useRevokeUserApiKey({ onSuccess }: { onSuccess?: () => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { keyId: string; reason?: string }>({
    mutationFn: async ({ keyId, reason }) => {
      await api.post(`/api/user-api-keys/${keyId}/revoke`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
      if (onSuccess) onSuccess();
    },
  });
}
