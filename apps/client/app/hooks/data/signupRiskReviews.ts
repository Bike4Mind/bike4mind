import type { SignupRiskReviewDecision, SignupRiskReviewDecisionResult, SignupRiskReviewItem } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const ENDPOINT = '/api/admin/signup-risk-reviews';
export const SIGNUP_RISK_REVIEWS_QUERY_KEY = ['admin-signup-risk-reviews'];

/** A queue row as it arrives over JSON: the dates are ISO strings. */
export type SignupRiskReviewRow = Omit<SignupRiskReviewItem, 'createdAt' | 'computedAt'> & {
  createdAt: string;
  computedAt: string;
};

export function useSignupRiskReviews() {
  return useQuery({
    queryKey: SIGNUP_RISK_REVIEWS_QUERY_KEY,
    queryFn: async () => (await api.get<{ data: SignupRiskReviewRow[]; truncated: boolean; reviewThreshold: number }>(ENDPOINT)).data,
  });
}

/** Approve pending accounts, or reopen approved ones (the undo of approve). */
export function useSignupRiskReviewDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision: Omit<SignupRiskReviewDecision, 'reason'> & { reason: string }) =>
      (await api.post<SignupRiskReviewDecisionResult>(ENDPOINT, decision)).data,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SIGNUP_RISK_REVIEWS_QUERY_KEY }),
  });
}
