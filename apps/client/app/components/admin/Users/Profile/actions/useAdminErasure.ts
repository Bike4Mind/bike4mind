import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AdminErasurePreview, AdminErasureState } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';

const erasurePath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}/erasure`;

export const adminErasureQueryKey = (userId: string) => ['admin', 'users', userId, 'erasure'] as const;

const toastFailure = (error: unknown, fallback: string) => {
  if (isStepUpCancelled(error)) return;
  const message = isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : undefined;
  toast.error(message ?? fallback);
};

export const useAdminErasureState = (userId: string) =>
  useQuery({
    queryKey: adminErasureQueryKey(userId),
    queryFn: async () => (await api.get<AdminErasureState>(erasurePath(userId))).data,
  });

export const usePreviewAdminErasure = (userId: string) =>
  useMutation({
    mutationFn: async (reason: string) =>
      (await api.post<AdminErasurePreview>(`${erasurePath(userId)}/preview`, { reason })).data,
    onError: error => toastFailure(error, 'Could not run the erasure dry run.'),
  });

export const useRequestAdminErasure = (userId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) => (await api.post<{ queued: boolean }>(erasurePath(userId), { reason })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminErasureQueryKey(userId) }),
    onError: error => toastFailure(error, 'Could not start the erasure.'),
  });
};
