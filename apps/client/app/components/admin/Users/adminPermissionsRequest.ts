import type { AdminPermissionId } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

export type AdminPermissionsUpdate = {
  isAdmin: boolean;
  adminPermissions: readonly AdminPermissionId[];
  reason: string;
};

/**
 * The only write path for full admin access and delegated grants; users/[id]/update rejects
 * `isAdmin`. Server side: pages/api/admin/users/[userId]/permissions.ts.
 */
export async function putAdminPermissions(userId: string, update: AdminPermissionsUpdate): Promise<void> {
  await api.put(`/api/admin/users/${userId}/permissions`, { ...update, reason: update.reason.trim() });
}

export async function invalidateAdminPermissionQueries(queryClient: QueryClient, userId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['users'] }),
    queryClient.invalidateQueries({ queryKey: ['user', userId] }),
    queryClient.invalidateQueries({ queryKey: ['identify'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', userId] }),
  ]);
}

/** The server's own refusal (for example the last-full-admin guard) when there is one. */
export const adminRequestErrorMessage = (error: unknown, fallback: string): string => {
  if (isAxiosError<{ error?: string }>(error)) return error.response?.data?.error ?? error.message;
  return error instanceof Error ? error.message : fallback;
};
