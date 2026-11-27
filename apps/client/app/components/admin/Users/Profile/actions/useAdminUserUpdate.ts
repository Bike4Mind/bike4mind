import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { IUser, ThrottleTier, UserModerationStatus } from '@bike4mind/common';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { isApprovalPending, notifyApprovalSubmitted } from '@client/app/hooks/data/adminApprovals';

/**
 * Fields `PUT /api/users/[id]/update` accepts beyond the user document: audit reasons and credit moves.
 * The route refuses `isAdmin`; the role goes through useAdminUserRoleUpdate.
 */
export type AdminUserUpdate = Omit<Partial<IUser>, 'isAdmin'> & {
  creditDelta?: number;
  creditReason?: string;
  throttleTier?: ThrottleTier;
  throttleReason?: string;
  statusChangeReason?: string;
  /** The text-moderation escalation state; the route applies it via setModerationStatus and audits it. */
  moderationStatus?: UserModerationStatus;
  /** Marks a reinstatement as the Undo of this admin's suspend: its detection grades are removed, not flipped to legitimate. */
  undoSuspension?: boolean;
};

export const adminUpdateErrorMessage = (error: unknown, fallback: string): string => {
  if (isAxiosError(error)) {
    const body: unknown = error.response?.data;
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  }
  return fallback;
};

/**
 * One audited write to a user from the profile. Unlike `useUpdateUser` it shows no success toast: the
 * caller confirms with an UndoToast. Failures toast here and rethrow so an ActionDialog stays open.
 */
export const useAdminUserUpdate = (userId: string) => {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: AdminUserUpdate) => updateUserToServer(userId, data as Partial<IUser>),
    onSuccess: data => {
      // A credit grant to the admin's own account is held for a second admin (PUT /api/users/[id]/update).
      if (isApprovalPending(data)) return notifyApprovalSubmitted(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // Activity, credit history, ledger and entitlements all describe the account just written.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-credit-adjustments', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', userId] });
      // A suspend deactivates every API key server-side (adminUpdateUser).
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-api-keys', userId] });
    },
  });

  return async (data: AdminUserUpdate) => {
    try {
      return await mutation.mutateAsync(data);
    } catch (error) {
      if (!isStepUpCancelled(error)) toast.error(adminUpdateErrorMessage(error, 'The change was not saved.'));
      throw error;
    }
  };
};
