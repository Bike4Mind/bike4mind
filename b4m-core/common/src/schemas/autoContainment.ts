import { z } from 'zod';
import { AUTO_CONTAINMENT_MODES } from './settings';

/**
 * Automated containment decisions: what the executor decided for one shadow detection from its abuse
 * assessment, one record per detection. Shadow-mode records are graded against the detection's admin
 * verdict (shadowDetection.ts), so the precision of automated containment is measured before it is
 * enforced. Produced by apps/client/server/security/autoContainment; stored in the
 * AutoContainmentDecision collection (packages/database).
 */

export const AUTO_CONTAINMENT_OUTCOMES = [
  /** Enforce mode: claimed and the Contain path is running; a row left here means the run died. */
  'pending',
  /** Shadow mode: would have contained the accounts. */
  'would_contain',
  /** Enforce mode: the accounts were contained. */
  'contained',
  /** The per-hour cap was spent; nothing was done and an admin should look. */
  'capped',
  /** Enforce mode: the Contain path failed for at least one account. */
  'failed',
] as const;
export type AutoContainmentOutcome = (typeof AUTO_CONTAINMENT_OUTCOMES)[number];

export const autoContainmentDecisionItemSchema = z.object({
  id: z.string(),
  detectionId: z.string(),
  assessmentId: z.string(),
  mode: z.enum(AUTO_CONTAINMENT_MODES).exclude(['off']),
  outcome: z.enum(AUTO_CONTAINMENT_OUTCOMES),
  userIds: z.array(z.string()),
  confidence: z.number(),
  /** The audit reason the Contain path carries (or would carry): the evidence, in short. */
  reason: z.string(),
  /** The bulk batch that contained the accounts; null in shadow mode or when nothing ran. */
  batchId: z.string().nullable(),
  /** Short diagnostic for a failed outcome; never vendor text. */
  error: z.string().nullable(),
  decidedAt: z.date(),
});
export type AutoContainmentDecisionItem = z.infer<typeof autoContainmentDecisionItemSchema>;
