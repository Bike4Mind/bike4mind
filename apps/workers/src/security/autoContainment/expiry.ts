import { autoContainmentDecisionRepository, userRepository } from '@bike4mind/database';

export interface InterventionExpiryDeps {
  users: Pick<typeof userRepository, 'expireInterventionHolds'>;
  decisions: Pick<typeof autoContainmentDecisionRepository, 'markExpired'>;
}

const liveDeps: InterventionExpiryDeps = { users: userRepository, decisions: autoContainmentDecisionRepository };

/**
 * Stamps lapsed graduated holds and their decisions expired, for the audit trail. Access never waits
 * on this: every gate already ignores a hold past expiresAt (isActiveInterventionHold).
 */
export async function expireInterventionHolds(
  now: Date,
  deps: InterventionExpiryDeps = liveDeps
): Promise<{ holds: number; decisions: number }> {
  const decisionIds = await deps.users.expireInterventionHolds(now);
  const decisions = decisionIds.length > 0 ? await deps.decisions.markExpired(decisionIds, now) : 0;
  return { holds: decisionIds.length, decisions };
}
