import { z } from 'zod';
import {
  MCP_ACTION_REPLACED_ERROR_CODE,
  PENDING_ACTION_ALREADY_RESOLVED_ERROR_CODE,
  PENDING_ACTION_EXPIRED_ERROR_CODE,
  type ApiErrorCode,
} from '../apiErrorCodes';
import { ApiErrorSchema } from './chat';

/**
 * Wire schemas for answering an agent's pending approval (`/api/v1/pending-actions/{questId}/approve`
 * and `/deny`). The pending action is the confirm-before-run card on a quest; the same action ids and
 * lifecycle codes are carried by the `approval_needed` push so every client acts on it identically.
 */

/** Action identifiers shared by every client's notification buttons and by the push payload. */
export const PENDING_ACTION_DECISIONS = ['approve', 'deny'] as const;
export type PendingActionDecision = (typeof PENDING_ACTION_DECISIONS)[number];

export const PENDING_ACTION_ERROR_CODES = [
  MCP_ACTION_REPLACED_ERROR_CODE,
  PENDING_ACTION_EXPIRED_ERROR_CODE,
  PENDING_ACTION_ALREADY_RESOLVED_ERROR_CODE,
] as const satisfies readonly ApiErrorCode[];

export const PendingActionParamSchema = z.object({
  /** The quest the pending action is parked on (the `questId` of the push and of the transcript card). */
  questId: z.string().min(1),
});

export const PendingActionDecisionRequestSchema = z.object({
  /**
   * The `ts` of the pending action the user was shown. The decision applies to exactly that action
   * and never to a newer one that replaced it.
   */
  pendingActionTs: z.number().int().positive(),
});

export const PendingActionDecisionResponseSchema = z.object({
  success: z.boolean().describe('False when the action was approved but the tool reported a failure.'),
  message: z.string(),
  url: z.string().optional().describe('Link to what the tool created, when it returns one.'),
});

export const PendingActionErrorSchema = ApiErrorSchema.extend({
  errorCode: z.enum(PENDING_ACTION_ERROR_CODES).optional(),
});

export type PendingActionDecisionRequest = z.infer<typeof PendingActionDecisionRequestSchema>;
export type PendingActionDecisionResponse = z.infer<typeof PendingActionDecisionResponseSchema>;
