import {
  abuseAssessmentStoredItemSchema,
  accountCampaignGroupSchema,
  accountCampaignMemberSchema,
  shadowDetectionItemSchema,
  shadowDetectionVerdictEntrySchema,
  type AbuseAssessmentRunResponse,
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

const campaignGroupRowSchema = accountCampaignGroupSchema.extend({
  window: z.object({ from: z.string(), to: z.string() }),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  members: z.array(accountCampaignMemberSchema.extend({ signedUpAt: z.string() })),
});
export type CampaignGroupRow = z.infer<typeof campaignGroupRowSchema>;

/** A detection as it arrives over JSON: the dates are ISO strings. */
export const shadowDetectionRowSchema = shadowDetectionItemSchema.extend({
  detectedAt: z.string(),
  group: campaignGroupRowSchema.nullable(),
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
 * detection as it is now, so the admin can re-decide against it, and `message` is the server's
 * explanation when it sent one.
 */
export type ShadowDetectionVerdictResult =
  | { status: 'recorded'; item: ShadowDetectionRow }
  | { status: 'conflict'; item: ShadowDetectionRow; message: string | null };

const conflictBodySchema = z.object({ error: z.string().optional(), item: shadowDetectionRowSchema });

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
        return { status: 'conflict', item: body.data.item, message: body.data.error?.trim() || null };
      }
    },
    // A conflict also means the list is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: SHADOW_DETECTIONS_QUERY_KEY }),
  });
}

const ASSESSMENTS_ENDPOINT = `${ENDPOINT}/assessments`;
const ASSESSMENTS_QUERY_KEY = ['admin-shadow-detection-assessments'];

/** An assessment as it arrives over JSON: the date is an ISO string. */
export const abuseAssessmentRowSchema = abuseAssessmentStoredItemSchema.extend({ assessedAt: z.string() });
export type AbuseAssessmentRow = z.infer<typeof abuseAssessmentRowSchema>;

export type AbuseAssessmentRunResult =
  | { status: 'assessed'; cached: boolean; item: AbuseAssessmentRow }
  | Extract<AbuseAssessmentRunResponse, { status: 'skipped' }>;

/** Advisory assessments of one detection, newest first. Only fetched while `enabled`. */
export function useAbuseAssessments(detectionId: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: [...ASSESSMENTS_QUERY_KEY, detectionId],
    queryFn: async () =>
      (await api.get<{ data: AbuseAssessmentRow[] }>(ASSESSMENTS_ENDPOINT, { params: { detectionId } })).data.data,
    enabled,
  });
}

export function useRequestAbuseAssessment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (detectionId: string): Promise<AbuseAssessmentRunResult> =>
      (await api.post<AbuseAssessmentRunResult>(ASSESSMENTS_ENDPOINT, { detectionId })).data,
    onSuccess: (_result, detectionId) =>
      queryClient.invalidateQueries({ queryKey: [...ASSESSMENTS_QUERY_KEY, detectionId] }),
  });
}
