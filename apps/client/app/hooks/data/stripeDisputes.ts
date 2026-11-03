import {
  stripeDisputeContainSchema,
  stripeDisputeItemSchema,
  stripeDisputeResolutionSchema,
  type StripeDisputeList,
  type StripeDisputeListQuery,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { z } from 'zod';

const ENDPOINT = '/api/admin/stripe-disputes';
export const STRIPE_DISPUTES_QUERY_KEY = ['admin-stripe-disputes'];

/** A dispute as it arrives over JSON: the dates are ISO strings. */
export const stripeDisputeRowSchema = stripeDisputeItemSchema.extend({
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  resolution: stripeDisputeResolutionSchema.extend({ resolvedAt: z.string() }).nullable(),
  contain: stripeDisputeContainSchema.extend({ containedAt: z.string(), undoneAt: z.string().nullable() }).nullable(),
});
export type StripeDisputeRow = z.infer<typeof stripeDisputeRowSchema>;

export type StripeDisputeListResponse = Omit<StripeDisputeList, 'data'> & { data: StripeDisputeRow[] };

export function useStripeDisputes(query: StripeDisputeListQuery) {
  return useQuery({
    queryKey: [...STRIPE_DISPUTES_QUERY_KEY, query.state ?? null, query.subject ?? null],
    queryFn: async () => (await api.get<StripeDisputeListResponse>(ENDPOINT, { params: query })).data,
  });
}

/**
 * `conflict` means the dispute could not take the action (already resolved, nothing to undo, or a
 * later bulk action changed the user). `item` is the dispute as it is now when the server sent
 * one, and `message` is the server's explanation.
 */
export type StripeDisputeActionResult =
  | { status: 'done'; item: StripeDisputeRow }
  | { status: 'conflict'; item: StripeDisputeRow | null; message: string | null };

export type StripeDisputeActionRequest = { id: string; reason: string };

const conflictBodySchema = z.object({ error: z.string().optional(), item: stripeDisputeRowSchema.optional() });

function useStripeDisputeAction(path: 'resolve' | 'undo-contain') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: StripeDisputeActionRequest): Promise<StripeDisputeActionResult> => {
      try {
        const response = await api.post<StripeDisputeRow>(`${ENDPOINT}/${path}`, request);
        return { status: 'done', item: response.data };
      } catch (error) {
        if (!isAxiosError(error) || error.response?.status !== 409) throw error;
        const body = conflictBodySchema.safeParse(error.response.data);
        if (!body.success) throw error;
        return { status: 'conflict', item: body.data.item ?? null, message: body.data.error?.trim() || null };
      }
    },
    // A conflict also means the list is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: STRIPE_DISPUTES_QUERY_KEY }),
  });
}

export const useResolveStripeDispute = () => useStripeDisputeAction('resolve');
export const useUndoContainStripeDispute = () => useStripeDisputeAction('undo-contain');
