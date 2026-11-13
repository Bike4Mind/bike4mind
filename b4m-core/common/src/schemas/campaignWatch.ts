import { z } from 'zod';
import { AdminActionReasonSchema } from '../types/entities/adminActionReason';

export const CAMPAIGN_WATCH_MAX_MEMBERS = 500;
export const CampaignWatchIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i)
  .transform(value => value.toLowerCase());
export const CampaignWatchStatusSchema = z.enum(['open', 'closed']);
export const CampaignWatchCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  userIds: z
    .array(CampaignWatchIdSchema)
    .min(1)
    .max(CAMPAIGN_WATCH_MAX_MEMBERS)
    .refine(ids => new Set(ids).size === ids.length, 'Account ids must be unique'),
  sourceDetectionId: CampaignWatchIdSchema.optional(),
  reason: AdminActionReasonSchema,
});
export const CampaignWatchChangeSchema = z.strictObject({
  action: z.enum(['close', 'reopen', 'claim', 'check']),
  expectedRevision: z.number().int().nonnegative(),
  reason: AdminActionReasonSchema,
});
export const CampaignWatchListQuerySchema = z.object({
  status: CampaignWatchStatusSchema.default('open'),
  cursor: CampaignWatchIdSchema.optional(),
});
export const CampaignWatchSchema = z.object({
  id: CampaignWatchIdSchema,
  name: z.string(),
  userIds: z.array(CampaignWatchIdSchema),
  sourceDetectionId: CampaignWatchIdSchema.nullable(),
  ownerId: CampaignWatchIdSchema.nullable(),
  status: CampaignWatchStatusSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable(),
  lastCheckedAt: z.coerce.date().nullable(),
});
export const CampaignWatchPageSchema = z.object({
  items: z.array(CampaignWatchSchema),
  nextCursor: CampaignWatchIdSchema.nullable(),
});
export const CampaignWatchDetailSchema = z.object({
  watch: CampaignWatchSchema,
  ownerName: z.string().nullable(),
  members: z.array(
    z.object({
      id: CampaignWatchIdSchema,
      name: z.string().nullable(),
      available: z.boolean(),
      suspended: z.boolean(),
      credits: z.number().nullable(),
    })
  ),
});
export type CampaignWatch = z.infer<typeof CampaignWatchSchema>;
export type CampaignWatchCreate = z.infer<typeof CampaignWatchCreateSchema>;
export type CampaignWatchChange = z.infer<typeof CampaignWatchChangeSchema>;
export type CampaignWatchPage = z.infer<typeof CampaignWatchPageSchema>;
export type CampaignWatchDetail = z.infer<typeof CampaignWatchDetailSchema>;
