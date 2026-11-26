import type { Request } from 'express';
import {
  canAccessAdmin,
  isFullAdmin,
  type AutoContainmentDecisionItem,
  type InterventionReleaseCondition,
  type ShadowDetectionVerdict,
} from '@bike4mind/common';
import { autoContainmentDecisionRepository, userRepository } from '@bike4mind/database';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

export interface InterventionReleaseDeps {
  users: Pick<typeof userRepository, 'releaseInterventionHold' | 'hasUnreleasedInterventionHold' | 'findById'>;
  decisions: Pick<typeof autoContainmentDecisionRepository, 'release' | 'listForDetection'>;
}

const liveDeps = (): InterventionReleaseDeps => ({
  users: userRepository,
  decisions: autoContainmentDecisionRepository,
});

/** A failed decision may have applied some of its holds before it failed, so it is released like an applied one. */
const HOLDING_OUTCOMES: ReadonlySet<AutoContainmentDecisionItem['outcome']> = new Set(['intervened', 'failed']);

export type ReleaseActor = NonNullable<Parameters<typeof isFullAdmin>[0]> & { id: string };

/** An admin never releases their own account (or the one impersonating them), and only a full admin releases an admin. */
async function mayRelease(actor: ReleaseActor, userId: string, deps: InterventionReleaseDeps): Promise<boolean> {
  if (isSelfOrImpersonator(actor, userId)) return false;
  return isFullAdmin(actor) || !canAccessAdmin(await deps.users.findById(userId));
}

export interface InterventionReleaseInput {
  by: string;
  reason: string;
  condition: InterventionReleaseCondition;
  now: Date;
  /** Called for each account the actor may not release, whose hold stays on. */
  onSkip?: (userId: string) => void;
}

/**
 * Lifts one decision's graduated hold from `userIds` (every account it named by default). Each
 * account loses only the hold keyed by this decision: moderation, review state, held signup grants
 * and other decisions' holds stay. The decision record is marked released once no account still
 * carries its hold. Returns the accounts whose hold this call released.
 */
export async function releaseInterventionDecision(
  decision: AutoContainmentDecisionItem,
  input: InterventionReleaseInput & { userIds?: readonly string[]; actor?: ReleaseActor },
  deps: InterventionReleaseDeps = liveDeps()
): Promise<string[]> {
  if (decision.tier === 'contain') return [];
  const released: string[] = [];
  for (const userId of input.userIds ?? decision.userIds) {
    if (!decision.userIds.includes(userId)) continue;
    if (input.actor && !(await mayRelease(input.actor, userId, deps))) {
      input.onSkip?.(userId);
      continue;
    }
    if (await deps.users.releaseInterventionHold(userId, decision.id, { by: input.by, now: input.now })) {
      released.push(userId);
    }
  }
  if (!(await deps.users.hasUnreleasedInterventionHold(decision.id))) {
    await deps.decisions.release(decision.id, {
      by: input.by,
      reason: input.reason,
      condition: input.condition,
      now: input.now,
    });
  }
  return released;
}

/**
 * A legitimate verdict lifts every applied graduated hold its detection caused. Contain decisions
 * and holds an admin placed by hand are left alone.
 */
export async function releaseForLegitimateVerdict(
  detectionId: string,
  input: Omit<InterventionReleaseInput, 'condition'> & { userIds?: readonly string[]; actor?: ReleaseActor },
  deps: InterventionReleaseDeps = liveDeps()
): Promise<Array<{ decisionId: string; userIds: string[] }>> {
  const decisions = await deps.decisions.listForDetection(detectionId);
  const results: Array<{ decisionId: string; userIds: string[] }> = [];
  for (const decision of decisions) {
    if (decision.tier === 'contain' || !HOLDING_OUTCOMES.has(decision.outcome)) continue;
    const userIds = await releaseInterventionDecision(decision, { ...input, condition: 'legitimate_verdict' }, deps);
    results.push({ decisionId: decision.id, userIds });
  }
  return results;
}

/**
 * Verdict-route hook: a legitimate_* verdict releases the detection's graduated holds and audits each
 * account; confirmed_abuse and the rest leave them. Runs after the verdict committed, so a failure is
 * logged rather than thrown.
 */
export async function releaseHoldsAfterVerdict(
  req: Request<unknown, unknown, unknown, unknown, Record<string, unknown>>,
  detectionId: string,
  verdict: ShadowDetectionVerdict,
  reason: string
): Promise<void> {
  if (!verdict.startsWith('legitimate_')) return;
  try {
    const released = await releaseForLegitimateVerdict(detectionId, {
      by: req.user.id,
      reason,
      now: new Date(),
      actor: req.user,
      onSkip: userId =>
        req.logger.warn(`Automated hold left on ${userId}: the verdict's admin may not release that account`),
    });
    for (const { decisionId, userIds } of released) {
      for (const userId of userIds) {
        await recordAdminActionFromRequest(req, {
          action: 'user.intervention_hold.released',
          target: { kind: 'user', id: userId, displayName: userId },
          summary: `released an automated hold on a ${verdict} verdict`,
          reason,
          details: { decisionId, detectionId },
        });
      }
    }
  } catch (error) {
    req.logger.error(`Releasing automated holds failed for shadow detection ${detectionId}`, error);
  }
}
