import {
  acceptDocument,
  fetchProjectInvites,
  fetchUserInvites,
  IGetInvitesRequest,
  IGetInvitesResponse,
  refuseDocument,
  shareDocument,
} from '@client/app/utils/invitesAPICalls';
import {
  useMutation,
  UseMutationOptions,
  useQuery,
  useQueryClient,
  UseQueryOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { InviteType, MAX_BULK_ITEMS } from '@bike4mind/common';
import { isAxiosError } from 'axios';

function invalidateOrganizationInviteeSearch(queryClient: QueryClient, organizationId?: string) {
  return queryClient.invalidateQueries({
    queryKey: ['users'],
    predicate: query => {
      const parameters = query.queryKey[1];
      return (
        typeof parameters === 'object' &&
        parameters !== null &&
        'pendingInviteOrganizationId' in parameters &&
        (organizationId === undefined || parameters.pendingInviteOrganizationId === organizationId)
      );
    },
  });
}

interface DataInput {
  description?: string | null;
  recipients?: string[];
  id: string;
  type: InviteType;
  expiresAt?: Date | null;
  available?: number | null;
  permissions: string[];
}

export function useGetUserInvites(userId: string) {
  return useQuery({
    queryKey: ['invites', 'inbox'],
    queryFn: () => fetchUserInvites(userId),
    // A cached list can outlive an invite's expiry between refetches, so expired invites are
    // dropped here as well as in the REST query.
    select: invites => invites.filter(i => !i.expiresAt || new Date(i.expiresAt).getTime() > Date.now()),
    enabled: !!userId,
    staleTime: 1000 * 60 * 2, // 2 minutes - shorter cache for more responsive UX
    retry: 1,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchOnReconnect: true,
  });
}

export function useGetProjectInvites(
  { projectId, ...params }: IGetInvitesRequest,
  options?: Partial<UseQueryOptions<IGetInvitesResponse> & { queryKey?: string[] | string }> & { queryKey?: string[] }
) {
  return useQuery({
    queryKey: options?.queryKey ?? ['invites', 'projects', projectId, params?.statuses],
    queryFn: () => fetchProjectInvites(projectId, params),
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: options?.enabled ?? true,
    ...options,
  });
}

export function useShareDocument({
  onSuccess,
  onSettled,
  onError,
}: {
  onSuccess?: () => void;
  onSettled?: () => void;
  onError?: (err: Error) => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: DataInput) => await shareDocument(data),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['invites/share'] });
      if (variables.type === InviteType.Organization) invalidateOrganizationInviteeSearch(queryClient, variables.id);
      if (onSuccess) {
        onSuccess();
      } else {
        toast.success('Document share invite sent successfully');
      }
    },
    onError: error => {
      console.error(error);
      if (onError) {
        onError(error);
      } else {
        toast.error('Failed to share document');
      }
    },
    onSettled: () => {
      if (onSettled) onSettled();
    },
  });
}

export type BatchShareResponse = {
  results: { id: string; ok: boolean; link?: string; error?: string; rateLimited?: boolean }[];
  okCount: number;
  rateLimitMessage?: string;
};

/** One POST /api/invites/batch for up to MAX_BULK_ITEMS files or notebooks; the caller chunks. */
export function useBatchShare() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      type: InviteType.FabFile | InviteType.Session;
      ids: string[];
      recipients: string[];
      description?: string;
      permissions: string[];
    }) => (await api.post<BatchShareResponse>('/api/invites/batch', data)).data,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invites/share'] });
    },
  });
}

export function useAcceptDocument({
  onSuccess,
  onSettled,
  onError,
  isPublic,
}: {
  onSuccess?: () => void;
  onError?: () => void;
  onSettled: () => void;
  isPublic?: boolean;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => acceptDocument(id, isPublic),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['invites/accept'] });
      queryClient.invalidateQueries({ queryKey: ['invites', 'inbox'] });
      switch (result?.type) {
        case InviteType.Project:
          toast.success('Successfully joined the project');
          break;
        case InviteType.Organization:
          invalidateOrganizationInviteeSearch(queryClient, result.documentId);
          queryClient.invalidateQueries({ queryKey: ['organizations', result.documentId] });
          queryClient.invalidateQueries({ queryKey: ['users', 'organization', result.documentId] });
          toast.success('Successfully joined the organization');
          break;
        default:
          toast.success('Document share accepted successfully');
      }
      if (onSuccess) onSuccess();
    },
    onError: error => {
      console.error(error);
      if (onError) onError();
      let message = 'Failed to accept shared document';
      if (isAxiosError(error)) {
        message = error.response?.data?.error || message;
      }
      toast.error(message);
    },
    onSettled: () => onSettled(),
  });
}

export function useRefuseDocument({
  onSuccess,
  onSettled,
  onError,
  isPublic,
}: {
  onSuccess?: () => void;
  onError?: () => void;
  onSettled: () => void;
  isPublic?: boolean;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => await refuseDocument(id, isPublic),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites/refuse'] });
      queryClient.invalidateQueries({ queryKey: ['invites', 'inbox'] });
      invalidateOrganizationInviteeSearch(queryClient);
      toast.success('Document share refused successfully');
      if (onSuccess) onSuccess();
    },
    onError: error => {
      console.error(error);
      if (onError) onError();
      toast.error('Failed to refuse shared document');
    },
    onSettled: () => onSettled(),
  });
}

type BulkInviteResponse = {
  results: { id: string; ok: boolean; type?: InviteType; error?: string }[];
  okCount: number;
};

/** Accepts or refuses several invites with one POST /api/invites/bulk per MAX_BULK_ITEMS ids. */
export function useRespondToInvites({ onSettled }: { onSettled?: () => void } = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ action, ids }: { action: 'accept' | 'refuse'; ids: string[] }) => {
      let okCount = 0;
      for (let i = 0; i < ids.length; i += MAX_BULK_ITEMS) {
        try {
          const { data } = await api.post<BulkInviteResponse>('/api/invites/bulk', {
            action,
            ids: ids.slice(i, i + MAX_BULK_ITEMS),
          });
          okCount += data.okCount;
        } catch (error) {
          // Earlier chunks are committed server-side, so report them as a partial result.
          if (okCount === 0) throw error;
          break;
        }
      }
      return { action, okCount, total: ids.length };
    },
    onSuccess: ({ action, okCount, total }) => {
      const verb = action === 'accept' ? 'accepted' : 'refused';
      if (okCount === total) toast.success(`${total} document shares ${verb}`);
      else if (okCount > 0) toast.warning(`${okCount} of ${total} document shares ${verb}`);
      else toast.error(`Failed to ${action} the shared documents`);
    },
    onError: (error, { action }) => {
      console.error(error);
      let message = `Failed to ${action} the shared documents`;
      if (isAxiosError(error)) message = error.response?.data?.error || error.response?.data?.message || message;
      toast.error(message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', 'inbox'] });
      onSettled?.();
    },
  });
}

export const useDeleteInvite = (options?: UseMutationOptions<void, Error, { id: string }>) => {
  const { onSuccess, onError } = options || {};
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await api.delete(`/api/invites/${id}`);
    },
    onError: (...args) => {
      if (onError) onError(...args);
      toast.error('Failed to delete invite');
    },
    ...options,
    onSuccess: (...args) => {
      invalidateOrganizationInviteeSearch(queryClient);
      if (onSuccess) return onSuccess(...args);
      toast.success('Invite deleted successfully');
    },
  });
};

export const useCancelInvite = (callbacks: {
  onSuccess?: () => void;
  onError?: (err: Error) => void;
  onSettled?: () => void;
}) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { id: string; type: InviteType; email?: string; userId?: string }) => {
      // Deliberately the raw InviteType, not the lowercase alias GET/POST use: static routes such
      // as pages/api/projects/[id]/invites.ts shadow the [type] catch-all and register no DELETE,
      // so an aliased path would 404. The catch-all accepts either form.
      await api.delete(`/api/${params.type}/${params.id}/invites`, {
        data: { email: params.email, userId: params.userId },
      });
    },
    onSuccess: (_result, variables) => {
      if (variables.type === InviteType.Organization) invalidateOrganizationInviteeSearch(queryClient, variables.id);
      if (callbacks.onSuccess) callbacks.onSuccess();
    },
    onError: err => {
      if (callbacks.onError) callbacks.onError(err);
    },
    onSettled: () => {
      if (callbacks.onSettled) callbacks.onSettled();
    },
  });
};
