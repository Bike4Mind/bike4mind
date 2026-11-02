import {
  shadowDetectionItemSchema,
  shadowDetectionVerdictEntrySchema,
  type ShadowDetectionList,
  type ShadowDetectionListQuery,
  type ShadowDetectionVerdictRequest,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { z } from 'zod';

const ENDPOINT = '/api/admin/shadow-detections';
export const SHADOW_DETECTIONS_QUERY_KEY = ['admin-shadow-detections'];

/** A detection as it arrives over JSON: the dates are ISO strings. */
export const shadowDetectionRowSchema = shadowDetectionItemSchema.extend({
  detectedAt: z.string(),
  verdicts: z.array(shadowDetectionVerdictEntrySchema.extend({ reviewedAt: z.string() })),
});
export type ShadowDetectionRow = z.infer<typeof shadowDetectionRowSchema>;

export type ShadowDetectionListResponse = Omit<ShadowDetectionList, 'data'> & { data: ShadowDetectionRow[] };

export function useShadowDetections(query: ShadowDetectionListQuery) {
  return useQuery({
    queryKey: [...SHADOW_DETECTIONS_QUERY_KEY, query.detector ?? null, query.verdict ?? null],
    queryFn: async () => (await api.get<ShadowDetectionListResponse>(ENDPOINT, { params: query })).data,
  });
}

/**
 * `conflict` means another admin graded the detection first (its revision moved); `item` is the
 * detection as it is now, so the admin can re-decide against it.
 */
export type ShadowDetectionVerdictResult =
  { status: 'recorded'; item: ShadowDetectionRow } | { status: 'conflict'; item: ShadowDetectionRow };

const conflictBodySchema = z.object({ item: shadowDetectionRowSchema });

export function useShadowDetectionVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      request: Omit<ShadowDetectionVerdictRequest, 'reason'> & { reason: string }
    ): Promise<ShadowDetectionVerdictResult> => {
      try {
        const response = await api.post<ShadowDetectionRow>(`${ENDPOINT}/verdict`, request);
        return { status: 'recorded', item: response.data };
      } catch (error) {
        if (!isAxiosError(error) || error.response?.status !== 409) throw error;
        const body = conflictBodySchema.safeParse(error.response.data);
        if (!body.success) throw error;
        return { status: 'conflict', item: body.data.item };
      }
    },
    // A conflict also means the list is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: SHADOW_DETECTIONS_QUERY_KEY }),
  });
}
