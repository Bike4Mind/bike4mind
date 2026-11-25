import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';

export const ADMIN_SPACES_KEY = ['admin', 'spaces'] as const;

export type AdminSpacePerson = {
  userId: string;
  username: string | null;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedVia: 'invite' | 'link' | 'domain' | null;
  joinedAt: string | null;
  email?: string;
};

export type AdminSpaceRow = {
  id: string;
  name: string;
  owner: { id: string; username: string | null; email: string | null };
  memberCount: number;
  domainCount: number;
  parentOrganizationId: string | null;
  createdAt: string;
};

export type AdminSpaceList = { total: number; page: number; limit: number; spaces: AdminSpaceRow[] };

export type AdminSpaceDetail = {
  space: {
    id: string;
    name: string;
    description: string | null;
    parentOrganizationId: string | null;
    memberCount: number;
    createdAt: string | null;
    owner: AdminSpacePerson;
    members: AdminSpacePerson[];
  };
  domains: Array<{ id: string; domain: string; status: string; policy: string }>;
  pendingInviteCount: number;
};

export type AdminSpacesParams = { search: string; page: number; limit: number; sort: 'createdAt' | 'name' };

const apiErrorMessage = (err: unknown, fallback: string): string => {
  if (isAxiosError(err)) return err.response?.data?.error || err.response?.data?.message || err.message || fallback;
  return err instanceof Error ? err.message : fallback;
};

export function useAdminSpaces({ search, page, limit, sort }: AdminSpacesParams) {
  return useQuery({
    queryKey: [...ADMIN_SPACES_KEY, 'list', { search, page, limit, sort }],
    queryFn: async () =>
      (
        await api.get<AdminSpaceList>('/api/admin/spaces', {
          params: { search: search || undefined, page, limit, sort },
        })
      ).data,
    placeholderData: keepPreviousData,
  });
}

export function useAdminSpace(spaceId: string | null) {
  return useQuery({
    queryKey: [...ADMIN_SPACES_KEY, 'detail', spaceId],
    enabled: !!spaceId,
    queryFn: async () => (await api.get<AdminSpaceDetail>(`/api/admin/spaces/${spaceId}`)).data,
    retry: (count, error) => !(isAxiosError(error) && error.response?.status === 404) && count < 2,
  });
}

export function useAdminDeleteSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ spaceId, reason }: { spaceId: string; reason: string }) =>
      (await api.delete<{ id: string }>(`/api/admin/spaces/${spaceId}`, { data: { reason } })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_SPACES_KEY });
      toast.success('Space deleted');
    },
    onError: err => toast.error(apiErrorMessage(err, 'Could not delete the Space')),
  });
}

export function useAdminRemoveSpaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ spaceId, userId, reason }: { spaceId: string; userId: string; reason: string }) =>
      (await api.delete(`/api/admin/spaces/${spaceId}/members/${userId}`, { data: { reason } })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ADMIN_SPACES_KEY });
      toast.success('Member removed');
    },
    onError: err => toast.error(apiErrorMessage(err, 'Could not remove the member')),
  });
}
