import { useMutation, useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  IOrganizationDocument,
  WithId,
  FileGeneratePresignedUrlRequestInputType,
  FileGeneratePresignedUrlResponseType,
} from '@bike4mind/common';
import { toast } from 'sonner';
import { AxiosResponse } from 'axios';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { useGetOrganizationUsers } from './user';
import { useMemo } from 'react';
import { getErrorMessage } from '@client/app/utils/error';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';

/**
 * Hook to search organizations with pagination and filtering
 * Uses infinite query pattern similar to useSearchProjects
 */
export function useSearchUserOrganizations(
  userId: string,
  search: string,
  filters?: {}, // Add additional filters here
  orderBy?: { by: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' },
  options?: { enabled?: boolean }
) {
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['organizations', 'search', { userId, search, filters, orderBy }],
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { signal } = params;
      const { page = 1 } = params.pageParam || {};
      try {
        // Merge provided filters with the userId constraint
        const requestFilters = { ...(filters || {}), userId } as Record<string, unknown>;

        const response = await api.get<{ data: WithId<IOrganizationDocument>[]; hasMore: boolean }>(
          '/api/organizations',
          {
            signal,
            params: {
              query: search,
              filters: requestFilters,
              pagination: {
                page,
                limit: 16,
              },
              orderBy,
            },
          }
        );

        signal.throwIfAborted();
        response.data.data.forEach(organization => {
          queryClient.setQueryData(['organizations', organization.id], organization);
        });

        return response.data;
      } catch (e) {
        signal.throwIfAborted();
        return { data: [], hasMore: false };
      }
    },
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return { page: page + 1 };
      }
      return undefined;
    },
    enabled: options?.enabled ?? true,
  });
}

/**
 * Hook to search organizations with pagination and filtering
 * Uses standard useQuery with page-based pagination (like admin users tab)
 */
export function useSearchOrganizations(
  params: {
    page: number;
    limit: number;
    search: string;
    filters?: { personal?: boolean };
    orderBy?: { by: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' };
  },
  options?: { enabled?: boolean }
) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['organizations', 'search', params],
    queryFn: async ({ signal }) => {
      try {
        const response = await api.get<{
          data: WithId<IOrganizationDocument>[];
          hasMore: boolean;
          total: number;
        }>('/api/organizations', {
          signal,
          params: {
            query: params.search,
            filters: params.filters,
            pagination: {
              page: params.page,
              limit: params.limit,
            },
            orderBy: params.orderBy,
          },
        });

        signal.throwIfAborted();
        response.data.data.forEach(organization => {
          queryClient.setQueryData(['organizations', organization.id], organization);
        });

        return {
          data: response.data.data,
          totalPages: Math.ceil(response.data.total / params.limit),
          totalOrganizations: response.data.total,
        };
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    },
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 3,
  });
}

/**
 * Hook to get a single organization by ID
 */
export function useGetOrganization(orgId: string | null | undefined) {
  return useQuery({
    queryKey: ['organizations', orgId],
    queryFn: async ({ signal }) => {
      if (!orgId) return null;
      const response = await api.get<WithId<IOrganizationDocument>>(`/api/organizations/${orgId}`, { signal });
      signal.throwIfAborted();
      return response.data;
    },
    enabled: !!orgId,
    retry: (count, error) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      return status !== 400 && status !== 403 && status !== 404 && count < 2;
    },
    refetchOnMount: 'always',
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Hook to create a new organization
 */
export function useCreateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const response = await api.post<WithId<IOrganizationDocument>>('/api/organizations', { name });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Organization created successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to create organization:', error);
      toast.error(`Failed to create organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

/**
 * Hook to update an organization
 */
export function useUpdateOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      orgId,
      data,
    }: {
      orgId: string;
      // creditReason is required by the server whenever an admin changes currentCredits.
      data: Partial<IOrganizationDocument> & { creditReason?: string };
    }) => {
      const response = await api.put<WithId<IOrganizationDocument>>(`/api/organizations/${orgId}`, data);
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.setQueryData(['organizations', data.id], data);
      toast.success('Organization updated successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to update organization:', error);
      toast.error(`Failed to update organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

/**
 * Hook to delete an organization
 */
export function useDeleteOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      await api.delete(`/api/organizations/${orgId}`);
      return orgId;
    },
    onSuccess: async orgId => {
      // Org-scoped queries (detail, invites) 401 or 404 once the org is gone, and a 401 is read as an
      // expired session. Two things can still fire them: the settings page, which stays mounted until the caller
      // navigates, and the Teams list, whose cards mount per cached org. So the org leaves every cached list
      // synchronously, before the caller navigates, and its own queries are neither refetched nor removed
      // (removing a mounted query makes it refetch); they garbage-collect after the page unmounts.
      await queryClient.cancelQueries({ queryKey: ['organizations', orgId] });
      updateAllQueryData(
        queryClient,
        'organizations',
        'delete',
        { id: orgId },
        {
          keysAllowedToCreate: [],
          synchronous: true,
        }
      );
      void queryClient.invalidateQueries({
        queryKey: ['organizations'],
        predicate: query => query.queryKey[1] !== orgId,
      });
      toast.success('Team deleted successfully');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Hook to upload an organization logo
 */
export function useUploadOrganizationLogo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      organizationId,
      fileInfo,
      file,
    }: {
      organizationId: string;
      fileInfo: FileGeneratePresignedUrlRequestInputType;
      file: File | Blob;
    }) => {
      // Step 1: Get a presigned URL for the upload
      const { data } = await api.post<
        FileGeneratePresignedUrlResponseType,
        AxiosResponse<FileGeneratePresignedUrlResponseType>,
        FileGeneratePresignedUrlRequestInputType
      >(`/api/organizations/${organizationId}/upload-logo`, fileInfo);

      const { url, fileId } = data;

      // Step 2: Upload the bytes. The shared helper handles both shapes the server can hand back:
      // an S3 presign (hosted, raw axios) and the same-origin app-file proxy (self-host, authed api).
      await uploadFileToUrl(url, file, file.type);

      return fileId;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organizations', variables.organizationId] });
      toast.success('Logo uploaded successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to upload logo:', error);
      toast.error(`Failed to upload logo: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

export function useGetUserOrganizations(
  userId: string | undefined | null,
  { refetchOnMount = false }: { refetchOnMount?: boolean | 'always' } = {}
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['organizations', 'user', userId],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<{ data: IOrganizationDocument[]; hasMore: boolean; total: number }>(
        '/api/organizations',
        {
          signal,
          params: {
            filters: { userId },
            pagination: { page: 1, limit: 100 },
            orderBy: { by: 'name', direction: 'asc' },
          },
        }
      );

      // Cancellation must also stop manual cache writes from a response already in flight.
      signal.throwIfAborted();
      data.data.forEach(d => {
        updateAllQueryData(queryClient, 'organizations', 'write', d, {
          keysAllowedToCreate: [],
          synchronous: true,
        });
      });

      return data.data;
    },
    enabled: !!userId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnMount,
  });
}

/**
 * Success text for one or more removals, given each response's `personalLakeSharesKept`. Notification
 * is best-effort and already attempted server-side (the route awaits it ahead of res.json), so this
 * never claims delivery. `null` means the post-departure read failed, so no owner was notified; an
 * ABSENT field is an API response from before the count existed, which keeps the plain message.
 */
export function removedMembersMessage(kept: readonly (number | null | undefined)[]): string {
  const single = kept.length === 1;
  const shares = kept.reduce<number>((sum, k) => sum + (k ?? 0), 0);
  const unchecked = kept.filter(k => k === null).length;
  if (!shares && !unchecked) return single ? 'Member removed successfully' : `${kept.length} members removed`;
  const parts = [single ? 'Member removed.' : `${kept.length} members removed.`];
  if (shares) {
    const one = shares === 1;
    parts.push(
      `${shares} share${one ? '' : 's'} on personal data lakes ${one ? 'was' : 'were'} kept; the lake owners are being notified.`
    );
  }
  if (unchecked) {
    parts.push(
      single
        ? 'Personal data lake shares could not be checked, so the lake owners were not notified.'
        : `Personal data lake shares could not be checked for ${unchecked} of them, so those lake owners were not notified.`
    );
  }
  return parts.join(' ');
}

export interface OffboardingInventoryEntry {
  count: number;
  sample: { id: string; name: string }[];
}

/** Mirrors MemberOffboardingInventory in b4m-core/services organizationService/getMemberOffboardingInventory. */
export interface MemberOffboardingInventory {
  files: OffboardingInventoryEntry;
  artifacts: OffboardingInventoryEntry;
  projects: OffboardingInventoryEntry;
  notebooks: OffboardingInventoryEntry;
  agents: OffboardingInventoryEntry;
  orgBilledApiKeys: { count: number };
}

const memberOffboardingKey = (organizationId: string, userId: string) =>
  ['organizations', organizationId, 'members', userId, 'offboarding'] as const;

const removeMemberKey = ['organizations', 'remove-member'] as const;

interface RemoveMemberVariables {
  /** Bulk callers show one summary rather than a toast for each member. */
  quiet?: boolean;
  organizationId: string;
  userId: string;
  /** Member who takes over the departing member's org content; omitted keeps it with them. */
  reassignTo?: string;
}

export function useMemberOffboardingInventory(
  organizationId: string,
  userId: string | null,
  { enabled }: { enabled: boolean }
) {
  // Current membership suppresses post-removal reads and allows a later re-added member to load.
  return useQuery({
    queryKey: memberOffboardingKey(organizationId, userId ?? ''),
    queryFn: async () => {
      const { data } = await api.get<MemberOffboardingInventory>(
        `/api/organizations/${organizationId}/members/${userId}/offboarding`
      );
      return data;
    },
    enabled: !!userId && enabled,
    staleTime: 0,
  });
}

export function useRemoveMemberFromOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: removeMemberKey,
    mutationFn: async ({ organizationId, userId, reassignTo }: RemoveMemberVariables) => {
      const response = await api.delete<
        WithId<IOrganizationDocument> & {
          personalLakeSharesKept?: number | null;
          revokedOrgBilledKeys?: number;
          reassigned?: unknown;
        }
      >(`/api/organizations/${organizationId}/members/${userId}`, reassignTo ? { data: { reassignTo } } : undefined);
      const { personalLakeSharesKept, revokedOrgBilledKeys, reassigned, ...organization } = response.data;

      // A pre-removal roster/search response must not restore the departed member in the cache.
      await queryClient.cancelQueries({ queryKey: ['organizations'] });
      updateAllQueryData(queryClient, 'organizations', 'write', organization, {
        keysAllowedToCreate: [],
        synchronous: true,
      });

      return personalLakeSharesKept;
    },
    onSuccess: (kept, variables) => {
      // Drop the removed member's inventory before the ['organizations'] prefix invalidation can refetch it.
      const offboardingKey = memberOffboardingKey(variables.organizationId, variables.userId);
      void queryClient.cancelQueries({ queryKey: offboardingKey });
      queryClient.removeQueries({ queryKey: offboardingKey });
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', variables.organizationId] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // Removing a member may hand their lakes to a successor, changing ownership-derived flags.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      if (variables.reassignTo) {
        const contentQueryKeys = [
          fabFileKeys.all,
          ['projects'],
          ['joined-projects'],
          ['sessions'],
          ['own-session-count'],
          ['agents'],
          ['session-agents'],
          ['artifact'],
          ['session-artifacts'],
        ] as const;
        for (const queryKey of contentQueryKeys) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }

      if (!variables.quiet) toast.success(removedMembersMessage([kept]));
    },
    onError: (error: unknown, variables) => {
      console.error('Failed to remove member:', error);
      if (!variables.quiet) {
        toast.error(`Failed to remove member: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    },
  });
}

/** Shared write-back for the two credit-budget routes, which both return the updated org. */
function useCreditBudgetMutation<Variables extends { organizationId: string }>(
  request: (variables: Variables) => Promise<WithId<IOrganizationDocument>>,
  successMessage: string
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: organization => {
      updateAllQueryData(queryClient, 'organizations', 'write', organization);
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success(successMessage);
    },
    onError: (error: unknown) => {
      console.error('Failed to update credit limit:', error);
      toast.error(`Failed to update credit limit: ${getErrorMessage(error)}`);
    },
  });
}

/** Set or clear (null) the org's default monthly credit limit per member. */
export function useSetMemberCreditDefault() {
  return useCreditBudgetMutation(
    async ({ organizationId, maxCreditsPerMember }: { organizationId: string; maxCreditsPerMember: number | null }) => {
      const response = await api.put<WithId<IOrganizationDocument>>(
        `/api/organizations/${organizationId}/member-credit-budget`,
        { maxCreditsPerMember }
      );
      return response.data;
    },
    'Monthly credit limit updated'
  );
}

/** Set or clear (null, inherit the org default) one member's monthly credit limit. */
export function useSetMemberCreditOverride() {
  return useCreditBudgetMutation(
    async ({
      organizationId,
      userId,
      maxCredits,
    }: {
      organizationId: string;
      userId: string;
      maxCredits: number | null;
    }) => {
      const response = await api.put<WithId<IOrganizationDocument>>(
        `/api/organizations/${organizationId}/members/${userId}/credit-budget`,
        { maxCredits }
      );
      return response.data;
    },
    'Member credit limit updated'
  );
}

/** Make one member a manager, or remove them as one (owner or platform admin only). */
export function useSetOrganizationManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      organizationId,
      userId,
      isManager,
    }: {
      organizationId: string;
      userId: string;
      isManager: boolean;
    }) => {
      const url = `/api/organizations/${organizationId}/members/${userId}/manager`;
      const response = isManager
        ? await api.put<WithId<IOrganizationDocument>>(url)
        : await api.delete<WithId<IOrganizationDocument>>(url);
      return response.data;
    },
    onSuccess: (organization, { isManager }) => {
      updateAllQueryData(queryClient, 'organizations', 'write', organization);
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success(isManager ? 'Member is now a manager' : 'Manager removed');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to update manager: ${getErrorMessage(error)}`);
    },
  });
}

/** Hand the organization's billing ownership to one of its managers. */
export function useTransferOrganizationOwnership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organizationId, newOwnerId }: { organizationId: string; newOwnerId: string }) => {
      const response = await api.post<{ organizationId: string; ownerId: string }>(
        `/api/organizations/${organizationId}/transfer-ownership`,
        { newOwnerId }
      );
      return response.data;
    },
    onSuccess: () => {
      // The owner gates every org tab and the roster rows, so refetch rather than patch.
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['users', 'organization'] });
      toast.success('Ownership transferred');
    },
    onError: (error: unknown) => {
      toast.error(`Failed to transfer ownership: ${getErrorMessage(error)}`);
    },
  });
}

export function useLeaveOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ organizationId }: { organizationId: string }) => {
      const organization = await api.delete(`/api/organizations/${organizationId}/members`);

      updateAllQueryData(queryClient, 'organizations', 'write', organization.data);

      return organization;
    },
    onSuccess: () => {
      // Leaving may hand this member's lakes to a successor and removes their own lake access.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success('Left organization successfully');
    },
    onError: (error: unknown) => {
      console.error('Failed to leave organization:', error);
      toast.error(`Failed to leave organization: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });
}

interface OrganizationSeatsInfo {
  maxSeats: number;
  pendingSeats: number;
  currentSeats: number;
  availableSeats: number;
}

export function useOrganizationInvites(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ['organizations', organizationId, 'invites'],
    queryFn: async () => {
      const response = await api.get<ISharerInviteView[]>(`/api/organizations/${organizationId}/invites`);
      return response.data;
    },
    select: invites =>
      invites.filter(invite => invite.remaining > 0 && (!invite.expiresAt || new Date(invite.expiresAt) > new Date())),
    enabled: !!organizationId,
  });
}

export const useOrganizationSeats = (organizationId?: string): OrganizationSeatsInfo => {
  const { data: organization } = useGetOrganization(organizationId);
  const { data: users } = useGetOrganizationUsers(organizationId);
  const { data: pendingInvites } = useOrganizationInvites(organizationId);

  const maxSeats = organization?.seats ?? 0;
  const pendingSeats =
    pendingInvites?.reduce((count, invite) => count + (invite.recipients?.pending?.length ?? 0), 0) ?? 0;
  const currentSeats = (users?.length ?? 0) + pendingSeats;
  const availableSeats = Math.max(0, maxSeats - currentSeats);

  return useMemo(
    () => ({
      maxSeats,
      pendingSeats,
      currentSeats,
      availableSeats,
    }),
    [maxSeats, pendingSeats, currentSeats, availableSeats]
  );
};

// Mirrors OrgInviteRow in b4m-core/services/src/sharingService/classifyOrgInviteRows.ts.
export type BulkInviteRowStatus =
  'invite' | 'already_member' | 'already_pending' | 'invalid' | 'duplicate' | 'seat_limit';

export interface BulkInviteRow {
  email: string;
  raw: string;
  status: BulkInviteRowStatus;
}

export interface BulkInviteResult {
  rows: BulkInviteRow[];
  invitedCount: number;
  inviteId: string | null;
}

export function useBulkInviteOrganization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      organizationId,
      emails,
      permissions,
    }: {
      organizationId: string;
      emails: string[];
      permissions: string[];
    }) => {
      const response = await api.post<BulkInviteResult>(`/api/organizations/${organizationId}/bulk-invite`, {
        emails,
        permissions,
      });
      return response.data;
    },
    onSuccess: (_result, { organizationId }) => {
      queryClient.invalidateQueries({ queryKey: ['organizations', organizationId, 'invites'] });
      queryClient.invalidateQueries({ queryKey: ['users', 'organization', organizationId] });
    },
  });
}

// Mirrors OrgInviteLinkView in apps/client/server/organizations/orgInviteLinks.ts.
export interface OrgInviteLink {
  id: string;
  link: string | null;
  permissions: string[];
  expiresAt: string | null;
  remaining: number;
  accepted: number;
  allowedDomains: string[];
  revokedAt: string | null;
}

const inviteLinksKey = (organizationId: string) => ['organizations', organizationId, 'invite-links'];

export function useOrganizationInviteLinks(organizationId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: inviteLinksKey(organizationId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<OrgInviteLink[]>(`/api/organizations/${organizationId}/invite-links`, {
        params: pageParam ? { after: pageParam } : undefined,
      });
      const nextCursor: unknown = response.headers['x-next-cursor'];
      return { links: response.data, nextCursor: typeof nextCursor === 'string' ? nextCursor : undefined };
    },
    getNextPageParam: page => page.nextCursor,
    select: data => data.pages.flatMap(page => page.links),
    enabled: enabled && !!organizationId,
  });
}

export function useCreateOrganizationInviteLink(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      permissions: string[];
      expiresAt: string;
      available?: number;
      allowedDomains?: string[];
    }) => (await api.post<{ link: string }>(`/api/organizations/${organizationId}/invite-links`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inviteLinksKey(organizationId) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useRevokeOrganizationInviteLink(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) =>
      (await api.delete<OrgInviteLink>(`/api/organizations/${organizationId}/invite-links/${inviteId}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inviteLinksKey(organizationId) }),
    onError: error => toast.error(getErrorMessage(error)),
  });
}

export function useResendOrganizationInvite(organizationId: string) {
  return useMutation({
    mutationFn: async (recipient: { email: string } | { userId: string }) =>
      (await api.post<{ resent: boolean }>(`/api/organizations/${organizationId}/invite-resend`, recipient)).data,
    onSuccess: () => toast.success('Invitation resent'),
    onError: error => toast.error(getErrorMessage(error)),
  });
}
