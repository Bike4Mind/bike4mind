import { z } from 'zod';

/** SQS message body for the Drive disconnect purge consumer (`apps/workers/src/queueHandlers/driveDisconnectPurge.ts`). */
export const DriveDisconnectPurgePayload = z.object({
  connectionId: z.string(),
  dataLakeId: z.string(),
  // Absent for a personal connection (one feeding an org-less lake).
  organizationId: z.string().optional(),
  // How many times this disconnect has waited out an in-flight sync; bounded by MAX_SYNC_DEFERRALS.
  syncDeferrals: z.number().int().nonnegative().optional(),
});
export type DriveDisconnectPurgePayload = z.infer<typeof DriveDisconnectPurgePayload>;
