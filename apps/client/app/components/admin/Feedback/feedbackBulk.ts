import { z } from 'zod';
import {
  AdminActionReasonSchema,
  FeedbackStatus,
  FeedbackType,
  FEEDBACK_RESOLUTIONS,
  FEEDBACK_SUBJECTS,
  FEEDBACK_AI_AREAS,
  FEEDBACK_AI_SEVERITIES,
} from '@bike4mind/common';
import { FEEDBACK_RECEIVED_WINDOWS } from './feedbackTrends';

export const FEEDBACK_BULK_MAX_REPORTS = 100;
const idSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .transform(id => id.toLowerCase());
export const FeedbackBulkSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('explicit'),
    ids: z
      .array(idSchema)
      .min(1)
      .max(FEEDBACK_BULK_MAX_REPORTS)
      .refine(ids => new Set(ids).size === ids.length, 'Report ids must be unique'),
  }),
  z.strictObject({
    mode: z.literal('allMatching'),
    filters: z.strictObject({
      userId: z.string().min(1).max(100).optional(),
      sessionId: z.string().min(1).max(100).optional(),
      questId: z.string().min(1).max(100).optional(),
      organizationId: idSchema.optional(),
      organization: z.array(z.string().max(200)).max(100).optional(),
      status: z.array(z.enum(FeedbackStatus)).min(1).max(3).optional(),
      type: z.array(z.enum(FeedbackType)).max(10).optional(),
      resolution: z.enum(FEEDBACK_RESOLUTIONS).optional(),
      subject: z.enum(FEEDBACK_SUBJECTS).optional(),
      area: z.enum(FEEDBACK_AI_AREAS).optional(),
      severity: z.enum(FEEDBACK_AI_SEVERITIES).optional(),
      received: z.enum(FEEDBACK_RECEIVED_WINDOWS).optional(),
      search: z.string().min(1).max(200).optional(),
      sort: z.enum(['asc', 'desc']).default('desc'),
    }),
  }),
]);
export const FeedbackBulkChangeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('delete') }),
  z
    .strictObject({
      action: z.literal('status'),
      status: z.enum(FeedbackStatus),
      resolution: z.enum(FEEDBACK_RESOLUTIONS).optional(),
      resolutionDuplicateId: idSchema.optional(),
    })
    .superRefine((body, ctx) => {
      if (body.status === FeedbackStatus.Closed && !body.resolution)
        ctx.addIssue({ code: 'custom', message: 'Choose a resolution before closing' });
      if (body.resolution === 'duplicate' && !body.resolutionDuplicateId)
        ctx.addIssue({ code: 'custom', message: 'Choose an original report' });
      if (body.status !== FeedbackStatus.Closed && body.resolution)
        ctx.addIssue({ code: 'custom', message: 'Only closed reports take a resolution' });
      if (body.resolutionDuplicateId && body.resolution !== 'duplicate')
        ctx.addIssue({ code: 'custom', message: 'Only duplicate resolutions take a report id' });
    }),
]);
export const FeedbackBulkRequestSchema = z
  .strictObject({
    selection: FeedbackBulkSelectionSchema,
    change: FeedbackBulkChangeSchema,
    preview: z.boolean(),
    reason: AdminActionReasonSchema.optional(),
    expectedCount: z.number().int().min(0).max(FEEDBACK_BULK_MAX_REPORTS).optional(),
    fingerprint: z
      .string()
      .regex(/^[a-f\d]{64}$/)
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (!body.preview && (!body.reason || body.expectedCount === undefined || !body.fingerprint))
      ctx.addIssue({ code: 'custom', message: 'Preview and a reason are required before applying' });
  });
export type FeedbackBulkSelection = z.infer<typeof FeedbackBulkSelectionSchema>;
export type FeedbackBulkChange = z.infer<typeof FeedbackBulkChangeSchema>;
export type FeedbackBulkRequest = z.input<typeof FeedbackBulkRequestSchema>;
export type FeedbackBulkResponse = { count: number; fingerprint: string; applied: boolean };
