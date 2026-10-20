import { z } from 'zod';

/** SQS message body for the data-lake cleanup consumer (`apps/workers/src/queueHandlers/dataLakeCleanup.ts`). */
export const CleanupPayload = z.object({
  dataLakeId: z.string(),
  // administeredOrgIds rides along so the async re-check keeps the org-manageable rung the request
  // path used (optional for back-compat with any message enqueued before this field existed).
  actor: z.object({
    userId: z.string(),
    isAdmin: z.boolean(),
    administeredOrgIds: z.array(z.string()).optional(),
  }),
  // The claim the lifecycle route accepted this message under, so a guard refusal releases only
  // that claim. Optional for messages enqueued before this field existed.
  purgeClaimId: z.string().optional(),
});
export type DataLakeCleanupMessage = z.input<typeof CleanupPayload>;
