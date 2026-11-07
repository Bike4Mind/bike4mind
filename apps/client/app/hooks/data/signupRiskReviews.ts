import type {
  SignupRiskAutoApprovalItem,
  SignupRiskReviewAdvisory,
  SignupRiskReviewDecision,
  SignupRiskReviewDecisionResult,
  SignupRiskReviewItem,
} from '@bike4mind/common';
import { PENDING_GRANTS_QUERY_KEY } from './adminSignupGrant';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const ENDPOINT = '/api/admin/signup-risk-reviews';
export const SIGNUP_RISK_REVIEWS_QUERY_KEY = ['admin-signup-risk-reviews'];

/** A queue row as it arrives over JSON: the dates are ISO strings. */
export type SignupRiskReviewRow = Omit<SignupRiskReviewItem, 'createdAt' | 'computedAt' | 'advisory'> & {
  createdAt: string;
  computedAt: string;
  advisory: (Omit<SignupRiskReviewAdvisory, 'assessedAt'> & { assessedAt: string }) | null;
};

/** An automatic approval as it arrives over JSON. */
export type SignupRiskAutoApprovalRow = Omit<SignupRiskAutoApprovalItem, 'decidedAt'> & { decidedAt: string };

export function useSignupRiskReviews() {
  return useQuery({
    queryKey: SIGNUP_RISK_REVIEWS_QUERY_KEY,
    queryFn: async () =>
      (
        await api.get<{
          data: SignupRiskReviewRow[];
          autoApproved: SignupRiskAutoApprovalRow[];
          truncated: boolean;
          reviewThreshold: number;
        }>(ENDPOINT)
      ).data,
  });
}

/** Approve pending accounts, or reopen approved ones (the undo of approve). */
export function useSignupRiskReviewDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision: Omit<SignupRiskReviewDecision, 'reason'> & { reason: string }) =>
      (await api.post<SignupRiskReviewDecisionResult>(ENDPOINT, decision)).data,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: SIGNUP_RISK_REVIEWS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY }),
      ]),
  });
}
