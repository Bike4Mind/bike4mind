import { z } from 'zod';

/**
 * Wire schemas for the device push-token endpoints (`/api/v1/push-tokens`).
 *
 * The enum tuples mirror PUSH_TOKEN_* in @bike4mind/database's PushTokenModel; the model is the
 * storage authority, these are the published request shape. Field names are camelCase to match the
 * first-party client's pinned payload.
 */

export const PUSH_TOKEN_KINDS = ['device', 'liveActivity'] as const;
export const PUSH_TOKEN_PLATFORMS = ['ios'] as const;
export const PUSH_TOKEN_ENVIRONMENTS = ['sandbox', 'production'] as const;

const MAX_TOKEN_LENGTH = 4096;
const MAX_LABEL_LENGTH = 256;

export const PushTokenRegisterRequestSchema = z.object({
  /** The platform push token, as issued by the platform. */
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  /** `device` is a per-install token; `liveActivity` is scoped to one activity. */
  kind: z.enum(PUSH_TOKEN_KINDS),
  platform: z.enum(PUSH_TOKEN_PLATFORMS),
  /** Which push gateway the token was issued for; a token only works against its own. */
  environment: z.enum(PUSH_TOKEN_ENVIRONMENTS),
  /** Live activity tokens: the activity the token drives. */
  activityId: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  /** Live activity tokens: the quest the activity reports on. */
  questId: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
  appVersion: z.string().min(1).max(MAX_LABEL_LENGTH).optional(),
});

export type PushTokenRegisterRequest = z.infer<typeof PushTokenRegisterRequestSchema>;

export const PushTokenUnregisterRequestSchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
});

export type PushTokenUnregisterRequest = z.infer<typeof PushTokenUnregisterRequestSchema>;
