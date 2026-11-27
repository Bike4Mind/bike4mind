import type { AssessmentSuggestionAccept } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PENDING_GRANTS_QUERY_KEY } from './adminSignupGrant';
import { SIGNUP_RISK_REVIEWS_QUERY_KEY } from './signupRiskReviews';

const ENDPOINT = '/api/admin/ai-assessment-suggestions/accept';
export const HELD_SIGNUP_GRANTS_QUERY_KEY = ['held-signup-grants'];

const QUERY_KEYS_BY_SURFACE: Record<AssessmentSuggestionAccept['surface'], readonly (readonly string[])[]> = {
  signupRiskReview: [SIGNUP_RISK_REVIEWS_QUERY_KEY],
  heldSignupGrant: [HELD_SIGNUP_GRANTS_QUERY_KEY, PENDING_GRANTS_QUERY_KEY],
};

/**
 * Accepts the abuse assessment on a user queue row. This records the agreement only; it changes
 * no credit or account state.
 */
export function useAcceptAssessmentSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: AssessmentSuggestionAccept) =>
      (await api.post<{ aiSuggestionId: string }>(ENDPOINT, request)).data,
    onSettled: (_result, _error, request) =>
      Promise.all(
        QUERY_KEYS_BY_SURFACE[request.surface].map(queryKey =>
          queryClient.invalidateQueries({ queryKey: [...queryKey] })
        )
      ),
  });
}
