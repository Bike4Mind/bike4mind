import { z } from 'zod';
import { AUTO_CONTAINMENT_MODES } from './settings';

/**
 * Automated containment decisions: what the executor decided for one shadow detection from its abuse
 * assessment, one record per (detection, revision): a campaign detection that gains members after a
 * decision gets a new one covering only the new members. Shadow-mode records are graded against the detection's admin
 * verdict (shadowDetection.ts), so the precision of automated containment is measured before it is
 * enforced. Produced by apps/client/server/security/autoContainment; stored in the
 * AutoContainmentDecision collection (packages/database).
 */

export const AUTO_CONTAINMENT_OUTCOMES = [
  /**
   * Claimed and still running. A row left here past the stale window means the run died; the next
   * run on the detection reclaims and retries it (as it does a time-budget-partial Contain).
   */
  'pending',
  /** Shadow mode: would have contained the accounts. */
  'would_contain',
  /** Enforce mode: the accounts were contained. */
  'contained',
  /** The per-hour cap was spent; nothing was done. Re-evaluated by the first run after the window resets. */
  'capped',
  /** Enforce mode: the Contain path failed for at least one account, or no account was eligible. */
  'failed',
  /** Enforce mode: an admin ruled on the detection after the decision and before the Contain ran. */
  'withdrawn',
] as const;
export type AutoContainmentOutcome = (typeof AUTO_CONTAINMENT_OUTCOMES)[number];

export const autoContainmentDecisionItemSchema = z.object({
  id: z.string(),
  detectionId: z.string(),
  /** The detection revision decided; a later revision is decided again for its new members only. */
  revision: z.number().int(),
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
