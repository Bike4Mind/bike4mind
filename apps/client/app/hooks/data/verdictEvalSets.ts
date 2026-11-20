import { api } from '@client/app/contexts/ApiContext';
import {
  evalSetDetailSchema,
  evalSetListSchema,
  evalSetRunResponseSchema,
  type EvalSetCreateInput,
  type EvalSetExampleVerdictRequest,
  type EvalSetRunRequest,
} from '@client/app/utils/verdictEvalSets';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

const ENDPOINT = '/api/admin/shadow-detections/eval-sets';
export const EVAL_SETS_QUERY_KEY = ['admin-eval-sets'];

const createdSchema = z.object({ id: z.string() });

export function useEvalSets() {
  return useQuery({
    queryKey: [...EVAL_SETS_QUERY_KEY, 'list'],
    queryFn: async () => evalSetListSchema.parse((await api.get(ENDPOINT)).data).data,
  });
}

export function useEvalSet(id: string | null) {
  return useQuery({
    queryKey: [...EVAL_SETS_QUERY_KEY, 'detail', id],
    queryFn: async () => evalSetDetailSchema.parse((await api.get(`${ENDPOINT}/${id}`)).data),
    enabled: id !== null,
  });
}

/** Draws a frozen set; resolves to its id. */
export function useCreateEvalSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: EvalSetCreateInput) => createdSchema.parse((await api.post(ENDPOINT, request)).data).id,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EVAL_SETS_QUERY_KEY }),
  });
}

/** Labels one example. A 409 means someone else got there first: refetch the set and review again. */
export function useEvalSetVerdict(setId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: EvalSetExampleVerdictRequest) => {
      await api.post(`${ENDPOINT}/${setId}/verdict`, request);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: EVAL_SETS_QUERY_KEY }),
  });
}

export function useRunEvalSet(setId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: EvalSetRunRequest) =>
      evalSetRunResponseSchema.parse((await api.post(`${ENDPOINT}/${setId}/runs`, request)).data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EVAL_SETS_QUERY_KEY }),
  });
}
