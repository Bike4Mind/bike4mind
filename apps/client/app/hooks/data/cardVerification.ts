import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { CREDIT_TRANSACTIONS_KEY, CREDITS_BALANCE_KEY } from './credits';

export type CardVerificationOffer = {
  available: boolean;
  credits: number;
  siteKey: string;
  saved: string[];
  pending: string[];
};

export type StartCardVerificationInput = {
  turnstileToken: string;
  saveCard: boolean;
  entry: 'billing' | 'exhaustion';
};

export type CardVerificationSession = {
  verificationId: string;
  clientSecret: string;
  publishableKey: string;
};

export type CompleteCardVerificationResult = {
  outcome: string;
  clientSecret?: string;
  publishableKey?: string;
};

const ENDPOINT = '/api/stripe/card-verification';
export const CARD_VERIFICATION_OFFER_KEY = ['card-verification-offer'] as const;

const GENERIC_ERROR_MESSAGE = 'Card verification could not finish. Please try again later.';

/** The server's user-facing refusal text when it sent one, else a generic message. */
export function getCardVerificationErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const body: unknown = error.response?.data;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const text = body.error;
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return GENERIC_ERROR_MESSAGE;
}

export function useCardVerificationOffer(enabled: boolean) {
  return useQuery({
    queryKey: CARD_VERIFICATION_OFFER_KEY,
    enabled,
    queryFn: async () => (await api.get<CardVerificationOffer>(ENDPOINT)).data,
    staleTime: 60000,
    retry: false,
  });
}

/** Re-reads the offer and the credit queries; a racing webhook may have granted credits. */
export function useRefreshCardVerification() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CARD_VERIFICATION_OFFER_KEY }),
      queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY }),
      queryClient.invalidateQueries({ queryKey: CREDIT_TRANSACTIONS_KEY }),
    ]);
  };
}

export function useStartCardVerification() {
  return useMutation({
    mutationFn: async (input: StartCardVerificationInput) =>
      (await api.post<CardVerificationSession>(ENDPOINT, input)).data,
  });
}

export function useCompleteCardVerification() {
  return useMutation({
    mutationFn: async (verificationId: string) =>
      (await api.post<CompleteCardVerificationResult>(ENDPOINT, { verificationId })).data,
  });
}

export function useRemoveCardVerification() {
  return useMutation({
    mutationFn: async (verificationId: string) => {
      await api.delete(ENDPOINT, { data: { verificationId } });
    },
  });
}
