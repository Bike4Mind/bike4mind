import {
  Collection,
  CollectionType,
  IActiveSessionDto,
  ICounterLogDocument,
  InviteType,
  ISessionDocument,
  IUser,
  IUserActivityCounterDocument,
  IUserDocument,
  PaginatedResponse,
  WithOrgRef,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import { useUser } from '@client/app/contexts/UserContext';
import { ErrorResponse } from '@client/app/utils/error';
import { updateAllQueryData } from '@client/app/utils/react-query';
import { revokeSharingOnServer } from '@client/app/utils/sharingApi';
import {
  fetchUsers,
  IGetUsersParams,
  IGetUsersResponse,
  updateUserToServer,
  fetchUserTags,
} from '@client/app/utils/userAPICalls';
import {
  keepPreviousData,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryOptions,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { useAccessToken } from '../useAccessToken';

export const useGetIdentify = () => {
  const currentUser = useUser(s => s.currentUser);
  const accessToken = useAccessToken(s => s.accessToken);

  return useQuery({
    queryKey: ['identify'],
    queryFn: async () => {
      const response = await api.get<{ user: IUserDocument; accessToken: string }>('/api/identify');
      return response.data;
    },
    // Seed initialData from the persisted user so the UI renders instantly on
    // cold load (no loading spinner). `initialDataUpdatedAt: 0` marks it
    // immediately stale so React Query fires a background /api/identify refetch
    // right away. Without this, the staleTime window suppresses the network call
    // and the identify effect feeds the stale persisted accessToken back into the
    // store -- which can overwrite a token the 401 interceptor just refreshed,
    // leaving data queries permanently failed (the "name shows but no data" bug).
    initialData:
      currentUser && accessToken && 'preferences' in currentUser ? { user: currentUser, accessToken } : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 1000 * 60 * 5, // 5 minutes
    // Only run query when there's an access token to avoid 401 errors for unauthenticated users
    enabled: !!accessToken,
  });
};

export function useGetUsers(params: IGetUsersParams, options?: Partial<UseQueryOptions<IGetUsersResponse>>) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: options?.queryKey ?? ['users', params],
    queryFn: async () => {
      const data = await fetchUsers(params);

      data.users.forEach(user => {
        queryClient.setQueryData(['users', user.id], user);
      });

      return data;
    },
    staleTime: 1000 * 60 * 3, // 3 minutes
    enabled: options?.enabled ?? true,
    ...options,
  });
}

export function useGetUser(id: string | null | undefined) {
  return useQuery({
    queryKey: ['users', id],
    queryFn: async () => {
      if (!id) return;
      const { data } = await api.get<WithOrgRef<IUserDocument>>(`/api/users/${id}`);
      return data;
    },
    staleTime: 1000 * 60 * 3, // 3 minutes
    enabled: !!id,
  });
}

export function useGetUserByEmail(email: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['users', 'by-email', email],
    queryFn: async () => {
      const { data } = await api.get<WithOrgRef<IUserDocument>>(`/api/users/by-email/${email}`);
      return data;
    },
    staleTime: 1000 * 60 * 3, // 3 minutes
    enabled: options?.enabled !== undefined ? !!email && options.enabled : !!email,
  });
}

export function useUpdateUser(options: { onSuccess?: () => void; onSettled?: () => void } = {}) {
  const queryClient = useQueryClient();
  const { onSuccess, onSettled } = options;

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<IUser> }) => await updateUserToServer(id, data),
    onSuccess: (freshUser, { id }) => {
      // Update the user cache immediately with the server response so that any
      // useEffect watching userData sees the new values, not stale pre-update data.
      if (freshUser) {
        queryClient.setQueryData(['users', id], freshUser);
      }
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // The sidebar account switcher reads currentUser from the UserContext store,
      // which is fed only by the ['identify'] query (5-min staleTime). Without this
      // invalidation, a profile name change stays stale in the switcher until a hard
      // refresh. Invalidating triggers a refetch that repopulates the context store.
      queryClient.invalidateQueries({ queryKey: ['identify'] });

      if (onSuccess) onSuccess();
      toast.success('Profile updated successfully');
    },
    onError(error: unknown) {
      let errorMessage = 'Failed to update Profile.';

      if (isAxiosError(error) && error.response) {
        const customError = error.response.data as ErrorResponse;
        errorMessage = customError.error ?? errorMessage;
      }

      toast.error(errorMessage);
    },
    onSettled: () => {
      if (onSettled) onSettled();
    },
  });
}

export function useGetUserActivityCounters(userId?: string | null) {
  return useQuery({
    queryKey: ['users', userId, 'activities'],
    queryFn: async () => {
      const { data } = await api.get<IUserActivityCounterDocument[]>(`/api/users/${userId}/activities`);
      return data;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
    enabled: !!userId,
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data } = await api.delete(`/api/users/${id}/delete`);
      return data;
    },
    onSuccess: () => {
      toast.success('User deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: error => toast.error('Failed to delete user'),
  });
}

export function useUserRevokeSharing(
  options: { onSuccess?: () => void; onSettled?: () => void; onError?: () => void } = {}
) {
  const { onSuccess, onSettled, onError } = options;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      type: InviteType.FabFile | InviteType.Session | InviteType.Project;
      id: string;
      userId: string;
    }) => {
      const { type, id, userId } = data;

      const document = await revokeSharingOnServer(type, id, userId);
      if (type === InviteType.Session) {
        updateAllQueryData(queryClient, 'sessions', 'write', document as ISessionDocument);
      } else if (type === InviteType.FabFile) {
        queryClient.setQueryData(['fabFiles', id], document);
      } else if (type === InviteType.Project) {
        queryClient.setQueryData(['projects', id], document);
        queryClient.invalidateQueries({
          queryKey: ['projects', id, 'members'],
        });
      }
    },
    onSuccess: () => {
      if (onSuccess) {
        onSuccess();
      } else {
        toast.success('Sharing updated successfully');
      }
    },
    onSettled: () => {
      if (onSettled) onSettled();
    },
    onError: () => {
      if (onError) {
        onError();
      } else {
        toast.error('Failed to update sharing');
      }
    },
  });
}

/**
 * Client-side teardown shared by every sign-out path (this-device logout, log-out-all-devices):
 * drop the in-memory user + tokens, wipe client persistence, purge queries (keeping only the
 * non-user-specific public server config), then hard-reload to /login so no in-memory state
 * (components, query subscriptions, WebSocket) survives. The server-side revoke differs per path
 * and is done by the caller BEFORE this runs.
 */
async function tearDownClientSession(opts: {
  setCurrentUser: (user: IUserDocument | null) => void;
  resetTokens: () => void;
  queryClient: QueryClient;
}): Promise<void> {
  opts.setCurrentUser(null);
  opts.resetTokens();
  // Clear all client-side persistence (IndexedDB: React Query, Dexie, TagCache,
  // and user-specific localStorage) before removing in-memory queries.
  await clearClientCaches();
  // Preserve server-config-public: it contains only apiUrl + defaultTheme and is not user-specific.
  // The full server-config (auth'd) is intentionally purged on logout to prevent
  // bucket names and the PDF Express key from persisting in memory across sessions.
  opts.queryClient.removeQueries({
    predicate: query => query.queryKey[0] !== 'server-config-public',
  });

  // Hard reload to /login to destroy all in-memory state (React components,
  // query subscriptions, WebSocket connections). Matches the pattern used by
  // loginAs/returnToAdmin flows which also use window.location.replace().
  const redirectTo = new URLSearchParams(window.location.search).get('redirectTo');
  const qs = redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : '';
  window.location.replace(`/login${qs}`);
}

export function useUserLogout() {
  const { setCurrentUser } = useUser();
  const resetTokens = useAccessToken(s => s.resetTokens);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      try {
        // Per-device: revokes ONLY this browser's session server-side (no tokenVersion bump),
        // so other devices stay signed in (issue #1194).
        await api.get('/api/logout');
      } catch (error) {
        // Ignore 401 errors during logout
        if (!isAxiosError(error) || error.response?.status !== 401) {
          throw error;
        }
      }
      await tearDownClientSession({ setCurrentUser, resetTokens, queryClient });
    },
  });
}

const ACTIVE_SESSIONS_KEY = ['users', 'me', 'sessions'] as const;

/** The caller's own active auth sessions (devices), newest-active first. Powers the
 *  Active Sessions list in Settings -> Security. */
export function useGetActiveSessions() {
  return useQuery({
    queryKey: ACTIVE_SESSIONS_KEY,
    queryFn: async () => {
      const res = await api.get<{ items: IActiveSessionDto[] }>('/api/users/me/sessions');
      return res.data.items;
    },
  });
}

/** Revoke a single session ("sign out this device") by sid, then refresh the list. */
export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sid: string) => {
      await api.delete('/api/users/me/sessions', { params: { sid } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ACTIVE_SESSIONS_KEY });
      toast.success('Device signed out');
    },
    onError: error => {
      const data = isAxiosError(error) ? (error.response?.data as ErrorResponse | undefined) : undefined;
      toast.error(data?.error ?? 'Failed to sign out device');
    },
  });
}

/**
 * "Log out all devices" - hits the global panic endpoint (bumps tokenVersion + revokes every
 * session, so all devices stop working immediately), then runs the same client teardown as a
 * normal logout since this device is signed out too.
 */
export function useLogoutAllDevices() {
  const { setCurrentUser } = useUser();
  const resetTokens = useAccessToken(s => s.resetTokens);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      try {
        await api.post('/api/users/me/sessions/logout-all');
      } catch (error) {
        if (!isAxiosError(error) || error.response?.status !== 401) {
          throw error;
        }
      }
      await tearDownClientSession({ setCurrentUser, resetTokens, queryClient });
    },
  });
}

export function useGetRecentActivities(options?: { coverage?: 'all' | 'important'; userId?: string }) {
  return useQuery({
    queryKey: ['activities', 'recent', options?.coverage, options?.userId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.coverage) params.append('coverage', options.coverage);
      if (options?.userId) params.append('userId', options.userId);

      const url = `/api/users/activities/recent${params.toString() ? `?${params.toString()}` : ''}`;
      const { data } = await api.get<ICounterLogDocument[]>(url);
      return data;
    },
    staleTime: 1000 * 30, // 30 seconds
  });
}

export function useGetFriends(userId: string | undefined | null) {
  return useQuery({
    queryKey: ['users', userId, 'friends'],
    queryFn: async () => {
      const { data } = await api.get<
        Array<{
          id: string;
          user: IUserDocument;
        }>
      >(`/api/users/${userId}/friends`);
      return data;
    },
    enabled: !!userId,
  });
}

export function useGetFriendRequests(userId: string | undefined | null) {
  return useQuery({
    queryKey: ['users', userId, 'friend-requests'],
    queryFn: async () => {
      const { data } = await api.get<
        Array<{
          id: string;
          user: IUserDocument;
        }>
      >(`/api/users/${userId}/friend-requests`);
      return data;
    },
    enabled: !!userId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

interface UserCollectionsParams {
  page: number;
  search?: string;
  type?: CollectionType | null;
}

export function useGetUserCollections(userId: string | undefined | null, params: UserCollectionsParams) {
  return useQuery({
    queryKey: ['users', userId, 'collections', params],
    queryFn: async () => {
      const searchParams = new URLSearchParams({
        page: params.page.toString(),
        ...(params.search && { search: params.search }),
        ...(params.type && { type: params.type }),
      });

      const { data } = await api.get<PaginatedResponse<Collection>>(
        `/api/users/${userId}/collections?${searchParams.toString()}`
      );
      return data;
    },
    placeholderData: keepPreviousData,
    enabled: !!userId,
  });
}

export function useLoginAsUser() {
  const queryClient = useQueryClient();
  const { setVerifiedSession, setImpersonating } = useAccessToken();
  const { setCurrentUser } = useUser();

  return useMutation({
    mutationFn: async ({ id, mfaToken }: { id: string; mfaToken: string }) => {
      const { data } = await api.post<{ user: IUserDocument; accessToken: string }>(`/api/users/${id}/loginAs`, {
        mfaToken,
      });
      return data;
    },
    onSuccess: async data => {
      // Cancel any in-flight queries (e.g. the app-wide admin-settings query) BEFORE
      // clearing caches, so a request dispatched under the admin token can't resolve
      // and re-persist admin data into IndexedDB after clearClientCaches() deletes it.
      await queryClient.cancelQueries();

      // Clear the previous (admin) identity's cached data. clearClientCaches() also
      // removes the persisted `user-context` key, so the impersonated identity must be
      // written AFTER it - otherwise the post-reload layout `beforeLoad` guard sees a
      // null currentUser and redirects to /login (logging the admin out).
      await clearClientCaches();

      // The token swap itself happened server-side: /api/users/[id]/loginAs parked the admin's
      // refresh token in the HttpOnly return cookie and handed the primary cookie to the
      // impersonated user. Nothing sensitive is stashed here any more - only the access token
      // (in memory) and the impersonation flag the UI reads.
      setVerifiedSession(data.accessToken);
      setImpersonating(true);
      setCurrentUser(data.user);

      // Remove in-memory queries only AFTER the impersonated identity is active, so any
      // observer-driven refetch (e.g. admin-settings) runs under the impersonated token.
      queryClient.removeQueries();

      toast.success('Successfully logged in as user');

      // Wait for state to persist before redirecting
      // This ensures the new user data is saved to localStorage
      setTimeout(() => {
        window.location.replace('/new');
      }, 50);
    },
    onError: error => {
      let errorMessage = 'Failed to login as user';

      if (isAxiosError(error) && error.response) {
        const customError = error.response.data as ErrorResponse;
        errorMessage = customError.error ?? errorMessage;
      }

      toast.error(errorMessage);
    },
  });
}

// Sentinel for a confirmed-dead admin return session (the return cookie is gone, expired, or
// its token was already rotated away). onError matches it EXACTLY (not a loose 'expired'
// substring) so an unrelated error can't trip force-logout.
export const ADMIN_SESSION_EXPIRED = 'Admin session has expired. Please log in again.';

// Customer-facing message for a transient (5xx / network) failure. No status code (not
// actionable for a user), and it must NOT equal the sentinel so onError leaves the session
// intact on flaky connectivity.
export const ADMIN_SESSION_VALIDATION_FAILED = "We couldn't verify your admin session. Please try again.";

/**
 * Maps a /api/auth/returnToAdmin response to the error message to throw, or null on success.
 * Pure so the "a 5xx must not force a logout" invariant is unit-testable without rendering the
 * mutation: only 401/403 yields the force-logout sentinel; any other non-OK yields a transient
 * message that onError won't act on.
 */
export function adminReturnValidationError(status: number, ok: boolean): string | null {
  if (status === 401 || status === 403) {
    return ADMIN_SESSION_EXPIRED;
  }
  if (!ok) {
    return ADMIN_SESSION_VALIDATION_FAILED;
  }
  return null;
}

export function useReturnToAdmin() {
  const queryClient = useQueryClient();
  const { setVerifiedSession, setImpersonating } = useAccessToken();
  const { setCurrentUser } = useUser();

  return useMutation({
    mutationFn: async () => {
      // The admin's refresh token lives in the HttpOnly return cookie, so the whole swap is a
      // single server round-trip: it rotates that token, hands it back as the primary refresh
      // cookie, revokes the impersonation session and returns a fresh admin access token.
      // Uses fetch rather than the `api` instance so the request interceptor can't attach the
      // impersonated user's bearer token - the route authenticates on the cookie alone.
      let res: Response;
      try {
        res = await fetch('/api/auth/returnToAdmin', { method: 'POST', credentials: 'same-origin' });
      } catch (err) {
        // Network failure (offline / DNS) - transient, like a 5xx: show the friendly message and
        // keep the session (not the ADMIN_SESSION_EXPIRED sentinel, so onError won't force a
        // logout) rather than a raw "Failed to fetch". Log the raw error first so genuinely
        // broken connectivity is visible in telemetry.
        console.warn('Return-to-admin request failed (network error):', err);
        throw new Error(ADMIN_SESSION_VALIDATION_FAILED);
      }
      // Only an auth rejection (401/403) means the admin's return cookie is actually dead and the
      // session must be torn down; any other non-OK (5xx) is transient and must not force a
      // logout. adminReturnValidationError encodes that rule (and is unit-tested).
      const validationError = adminReturnValidationError(res.status, res.ok);
      if (validationError) {
        throw new Error(validationError);
      }
      return (await res.json()) as { user: IUserDocument; accessToken: string };
    },
    onSuccess: async ({ user: adminUser, accessToken }) => {
      // Cancel in-flight queries (e.g. admin-settings) BEFORE clearing caches so a
      // request dispatched under the impersonated token can't resolve and re-persist
      // impersonated data after clearClientCaches() deletes the IndexedDB blob.
      await queryClient.cancelQueries();

      // Clear the impersonated user's cached data. clearClientCaches() also removes the
      // persisted `user-context` key, so the admin identity must be written AFTER it -
      // otherwise the post-reload layout `beforeLoad` guard sees a null currentUser and
      // redirects to /login.
      await clearClientCaches();

      setVerifiedSession(accessToken);
      setImpersonating(false);
      setCurrentUser(adminUser);

      // Remove in-memory queries only AFTER the admin identity is restored, so any
      // observer-driven refetch (e.g. admin-settings) runs under the admin token.
      queryClient.removeQueries();

      toast.success('Successfully returned to admin account');

      // Wait for state to persist before redirecting
      setTimeout(() => {
        window.location.replace('/new');
      }, 50);
    },
    onError: error => {
      const errorMessage = error instanceof Error ? error.message : 'Failed to return to admin account';

      toast.error(errorMessage);

      // Only a confirmed-dead return cookie (401/403) forces a full logout; transient
      // 5xx / network failures leave the session intact (don't log the admin out on flaky
      // connectivity). markSessionExpired() clears the session and stamps
      // expiredReason: 'expired'. Redirect via session_expired so the reason reliably shows on
      // the login page - the toast above can be lost when window.location.replace tears down the
      // DOM before sonner paints.
      if (errorMessage === ADMIN_SESSION_EXPIRED) {
        useAccessToken.getState().markSessionExpired();
        setCurrentUser(null);
        window.location.replace(buildLoginRedirectUrl('session_expired', window.location));
      }
    },
  });
}

export function useGetOrganizationUsers(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ['users', 'organization', organizationId],
    queryFn: async () => {
      // Do NOT seed ['users', id] from this response: the members endpoint returns the
      // minimal same-org shape (toSafeUsers), so seeding would shrink the full-profile
      // cache useGetUser reads and leave it stale for the query's staleTime.
      const { data } = await api.get<IUserDocument[]>(`/api/organizations/${organizationId}/members`);
      return data;
    },
    enabled: !!organizationId,
    refetchOnMount: 'always',
  });
}

export function useGetPendingOrganizationUsers(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ['users', 'organization', organizationId, 'pending'],
    queryFn: async () => {
      const { data } = await api.get<IUserDocument[]>(`/api/organizations/${organizationId}/pendingUsers`);
      return data;
    },
    enabled: !!organizationId,
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnMount: 'always',
  });
}

export function useGetUserTags() {
  return useQuery({
    queryKey: ['users', 'tags'],
    queryFn: fetchUserTags,
    staleTime: 1000 * 60 * 10, // 10 minutes
    select: data => data.tags,
  });
}

export function useToggleShowCreditsUsed() {
  const queryClient = useQueryClient();
  const { currentUser, setCurrentUser } = useUser();

  return useMutation({
    mutationFn: async (showCreditsUsed: boolean) => {
      if (!currentUser?.id) throw new Error('User not logged in');
      return await updateUserToServer(currentUser.id, { showCreditsUsed });
    },
    onMutate: async (showCreditsUsed: boolean) => {
      if (!currentUser) return;

      // Optimistically update the UI immediately
      const optimisticUser = { ...currentUser, showCreditsUsed };
      setCurrentUser(optimisticUser);
      queryClient.setQueryData(['users', currentUser.id], optimisticUser);

      // Return previous value for rollback
      return { previousValue: currentUser.showCreditsUsed };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: _ => toast.error('Failed to update settings'),
  });
}
