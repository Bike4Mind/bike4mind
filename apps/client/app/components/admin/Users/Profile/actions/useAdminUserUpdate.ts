import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { IUser } from '@bike4mind/common';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';

/** Fields `PUT /api/users/[id]/update` accepts beyond the user document: audit reasons and credit moves. */
export type AdminUserUpdate = Partial<IUser> & {
  creditDelta?: number;
  creditReason?: string;
  roleChangeReason?: string;
  statusChangeReason?: string;
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // Activity, credit history, ledger and entitlements all describe the account just written.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-credit-adjustments', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', userId] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'credit-adjustments'] });
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
