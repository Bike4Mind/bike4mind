import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NoCardUnlockReason, NoCardUnlockRefusal } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { CREDITS_BALANCE_KEY } from './credits';

export interface NoCardUnlockResult {
  creditsGranted: number;
  currentCredits: number;
  refusal?: NoCardUnlockRefusal;
}

export type PhoneUnlockStartResult = { sent: true; sentTo: string } | { sent: false; refusal: NoCardUnlockRefusal };

/** The one-click reasons; the phone unlock is a two-step flow with its own hooks below. */
export type OneClickUnlockReason = Exclude<NoCardUnlockReason, 'phone_verified'>;

const ROUTES: Record<OneClickUnlockReason, string> = {
  github_verified: '/api/credits/no-card-unlock/github',
  work_email_verified: '/api/credits/no-card-unlock/work-email',
};

function useRefreshCreditsOnGrant() {
  const queryClient = useQueryClient();
  return (result: NoCardUnlockResult) => {
    if (result.creditsGranted > 0) {
      queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY });
      queryClient.invalidateQueries({ queryKey: ['credit-transactions'] });
    }
  };
}

export function useNoCardUnlock() {
  const refresh = useRefreshCreditsOnGrant();
  return useMutation<NoCardUnlockResult, Error, OneClickUnlockReason>({
    mutationFn: async reason => (await api.post<NoCardUnlockResult>(ROUTES[reason])).data,
    onSuccess: refresh,
  });
}

export function usePhoneUnlockStart() {
  return useMutation<PhoneUnlockStartResult, Error, string>({
    mutationFn: async phoneNumber =>
      (await api.post<PhoneUnlockStartResult>('/api/credits/no-card-unlock/phone/start', { phoneNumber })).data,
  });
}

export function usePhoneUnlockVerify() {
  const refresh = useRefreshCreditsOnGrant();
  return useMutation<NoCardUnlockResult, Error, string>({
    mutationFn: async code =>
      (await api.post<NoCardUnlockResult>('/api/credits/no-card-unlock/phone/verify', { code })).data,
    onSuccess: refresh,
  });
}
