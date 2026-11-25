import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';

export type SpaceRole = 'owner' | 'admin' | 'member';

/** Mirrors SpacePersonView in server/spaces/spaceAccess.ts; `email` is present only for managers. */
export interface SpacePerson {
  userId: string;
  username: string | null;
  avatar: string | null;
  role: SpaceRole;
  joinedVia: 'invite' | 'link' | 'domain' | null;
  joinedAt: string | null;
  email?: string;
}

/** Mirrors SpaceView in server/spaces/spaceAccess.ts. */
export interface SpaceDetail {
  id: string;
  name: string;
  description: string | null;
  parentOrganizationId: string | null;
  viewerRole: SpaceRole;
  memberCount: number;
  owner: SpacePerson;
  members: SpacePerson[];
}

export interface SpaceSummary {
  id: string;
  name: string;
  description: string | null;
  parentOrganizationId: string | null;
  memberCount: number;
  isOwner: boolean;
}

export interface SpaceInviteLink {
  id: string;
  link: string;
  expiresAt: string | null;
  remaining: number;
  accepted: number;
  allowedDomains: string[];
  revokedAt: string | null;
}

export interface SpaceDomainSuggestion {
  spaceId: string;
  spaceName: string;
}

export interface CreateSpaceLinkBody {
  expiresAt: string;
  available?: number;
  allowedDomains?: string[];
}

const spacesKey = ['spaces'] as const;
const spaceKey = (id: string) => ['spaces', 'detail', id] as const;
const inviteLinksKey = (id: string) => ['spaces', 'detail', id, 'invite-links'] as const;
const invitesKey = (id: string) => ['spaces', 'detail', id, 'invites'] as const;
const base = (id: string) => `/api/spaces/${encodeURIComponent(id)}`;

export function useSpaces(enabled = true) {
  return useQuery({
    queryKey: [...spacesKey, 'mine'],
    queryFn: async () => (await api.get<SpaceSummary[]>('/api/spaces')).data,
    enabled,
  });
}

export function useSpace(id: string, enabled = true) {
  return useQuery({
    queryKey: spaceKey(id),
    queryFn: async () => (await api.get<SpaceDetail>(base(id))).data,
    enabled: enabled && !!id,
    retry: false,
  });
}

export function useCreateSpace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; description?: string }) =>
      (await api.post<SpaceDetail>('/api/spaces', body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useUpdateSpace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name?: string; description?: string | null }) =>
      (await api.patch<SpaceDetail>(base(id), body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteSpace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.delete(base(id));
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: spaceKey(id) });
      queryClient.invalidateQueries({ queryKey: [...spacesKey, 'mine'] });
    },
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useLeaveSpace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.post(`${base(id)}/leave`);
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: spaceKey(id) });
      queryClient.invalidateQueries({ queryKey: [...spacesKey, 'mine'] });
    },
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useTransferSpaceOwnership(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (newOwnerId: string) =>
      (await api.post<SpaceDetail>(`${base(id)}/transfer-ownership`, { newOwnerId })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useSetSpaceMemberRole(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: 'admin' | 'member' }) =>
      (await api.patch<SpaceDetail>(`${base(id)}/members/${encodeURIComponent(userId)}`, { role })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useRemoveSpaceMember(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.delete(`${base(id)}/members/${encodeURIComponent(userId)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useSpaceInvites(id: string, enabled = true) {
  return useQuery({
    queryKey: invitesKey(id),
    queryFn: async () => (await api.get<ISharerInviteView[]>(`${base(id)}/invites`)).data,
    enabled: enabled && !!id,
  });
}

export function useInviteToSpace(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (email: string) =>
      (await api.post(`${base(id)}/invites`, { permissions: [], recipients: [email] })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesKey(id) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useCancelSpaceInvite(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await api.delete(`/api/invites/${encodeURIComponent(inviteId)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesKey(id) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useSpaceInviteLinks(id: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: inviteLinksKey(id),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<SpaceInviteLink[]>(`${base(id)}/invite-links`, {
        params: pageParam ? { after: pageParam } : undefined,
      });
      const nextCursor: unknown = response.headers['x-next-cursor'];
      return { links: response.data, nextCursor: typeof nextCursor === 'string' ? nextCursor : undefined };
    },
    getNextPageParam: page => page.nextCursor,
    select: data => data.pages.flatMap(page => page.links),
    enabled: enabled && !!id,
  });
}

export function useCreateSpaceInviteLink(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateSpaceLinkBody) => (await api.post(`${base(id)}/invite-links`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inviteLinksKey(id) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useRevokeSpaceInviteLink(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) =>
      (await api.delete<SpaceInviteLink>(`${base(id)}/invite-links/${encodeURIComponent(inviteId)}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inviteLinksKey(id) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useSpaceDomainSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: [...spacesKey, 'domain-suggestions'],
    queryFn: async () =>
      (await api.get<{ suggestions: SpaceDomainSuggestion[] }>('/api/spaces/domain-suggestions')).data.suggestions,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useJoinSpaceViaDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`${base(id)}/domain-join`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spacesKey }),
  });
}
