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
import { InviteType } from '@bike4mind/common';
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
