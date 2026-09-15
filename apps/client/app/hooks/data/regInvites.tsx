import {
  createRegInvites,
  deleteRegInvites,
  getRegInvitesFromServer,
  IUserInvitation,
  submitReferral,
  submitUserInvitation,
  updateRegInvites,
} from '@client/app/utils/regInviteAPICalls';
import { IRegInviteDocument, RegInviteStatusType } from '@bike4mind/common';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

export function useGetRegInvites() {
  return useQuery({ queryKey: ['reg-invites'], queryFn: () => getRegInvitesFromServer(), staleTime: 1000 * 60 * 5 });
}

export function useUpdateRegInvites(options: { onSuccess?: () => void; onError?: () => void } = {}) {
  return useMutation({
    mutationFn: async (data: Partial<IRegInviteDocument & { ids: string[]; status: RegInviteStatusType }>) =>
      await updateRegInvites(data),
    onSuccess: () => {
      toast.success('Successfully updated registration invite(s)');
      if (options.onSuccess) options.onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to update registration invite');
      if (options.onError) options.onError();
    },
  });
}

export function useCreateRegInvites(options: { onSuccess?: () => void; onError?: () => void } = {}) {
  return useMutation({
    mutationFn: async (data: {
      multiple: number;
      unlimitedUse?: boolean;
      tags?: string[];
      startingCredits?: number;
      startingStorage?: number;
    }) => await createRegInvites(data),
    onSuccess: () => {
      toast.success('Registration invite(s) created');
      if (options.onSuccess) options.onSuccess();
    },
    onError: error => {
      console.error({ error });
      toast.error('Failed to create registration invite');
      if (options.onError) options.onError();
    },
  });
}

export function useDeleteRegInvites(options: { onSuccess?: () => void; onError?: () => void } = {}) {
  return useMutation({
    mutationFn: async (ids: string[]) => await deleteRegInvites(ids),
    onSuccess: () => {
      toast.success('Registration invite(s) deleted');
      if (options.onSuccess) options.onSuccess();
    },
    onError: error => {
      console.error({ error });
      toast.error('Failed to delete registration invite(s)');
      if (options.onError) options.onError();
    },
  });
}

export function useSubmitUserInvitation() {
  return useMutation({
    mutationFn: async (data: IUserInvitation) => await submitUserInvitation(data),
  });
}

export function useSubmitReferral() {
  return useMutation({
    mutationFn: async (data: IUserInvitation) => await submitReferral(data),
  });
}
