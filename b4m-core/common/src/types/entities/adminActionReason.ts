import { z } from 'zod';

export const ADMIN_ACTION_REASON_MIN_LENGTH = 5;
export const ADMIN_ACTION_REASON_MAX_LENGTH = 500;

/** The reason an admin gives for a reason-required action; shared by the API and the confirm dialogs. */
export const AdminActionReasonSchema = z
  .string({ error: 'A reason is required' })
  .trim()
  .min(ADMIN_ACTION_REASON_MIN_LENGTH, `A reason of at least ${ADMIN_ACTION_REASON_MIN_LENGTH} characters is required`)
  .max(ADMIN_ACTION_REASON_MAX_LENGTH);

export const isValidAdminActionReason = (value: string) => AdminActionReasonSchema.safeParse(value).success;
