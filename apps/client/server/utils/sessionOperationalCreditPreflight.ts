import { insufficientCreditsError, type ISessionDocument } from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService, isOperationalBillingEnabled, OPERATIONAL_BILLING_SETTING_NAMES } from '@bike4mind/services';
import { getSettingsMap } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';

/**
 * What one queued operational call is priced at for gating purposes. Deliberately a nominal
 * proxy, NOT a cost estimate: the real cost depends on the session's message volume and the
 * operational model, neither of which is known at queue time, and settlement is stochastic
 * (`usdToCreditsStochastic` charges floor(cost) plus a Bernoulli draw on the remainder, so a
 * single sub-credit call can settle 0 and an expensive one can settle several).
 *
 * Scaling it by the operation count is what makes the gate meaningful on the fan-out paths: it
 * keeps an unbounded batch from passing the same one-credit check a single tag would.
 */
const MIN_CREDITS_PER_OPERATION = 1;

/**
 * Operational calls a Summarize published with `callTagging` queues: the summary itself, plus the
 * Tag it cascades to at `sessionSummarization.ts:345`. Shared by the publishers that set the flag
 * so they cannot drift apart from the cascade they are counting.
 */
export const OPERATIONS_PER_SUMMARIZE_WITH_TAGGING = 2;

export interface SessionOperationalCreditPreflightArgs {
  /**
   * The credit holder: the SESSION OWNER, not necessarily the requester. The session-event
   * handlers bill `userId ?? session.userId` (e.g. sessionTagging.ts:89) and the publishers
   * gated here pass no userId, so a session shared into a project bills its owner.
   */
  userId: string;
  /**
   * Operational model calls this request will queue - one per session op, so a Summarize
   * published with `callTagging` counts 2 (it cascades to Tag at sessionSummarization.ts:345).
   * Scales the requirement, so a 500-notebook fan-out is not gated like a single tag.
   */
  operationCount: number;
  /** Named in the refusal message, e.g. 'session tagging'. */
  operation: string;
  logger?: Logger;
}

/** Discriminated so a caller that must not fail its primary action can branch on the reason. */
export type SessionOperationalCreditVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Credit pre-flight for the request handlers that queue session operational work. That work
 * settles asynchronously through `recordSessionOperationalUsage` -> `recordOperationalUsage`,
 * which is debit-capable but deliberately exempt from the per-member cap (#1651) because it must
 * never throw. This is therefore the only enforcement point for the cap on these paths (#1852) -
 * the mirror of the pre-flight `pages/api/data-lakes/semantic-search.ts` runs for the sibling
 * caller.
 *
 * Scoped to the `SessionEvents` publishers that are NOT already behind a gated primary action:
 * `POST /api/sessions/[id]/tag`, `POST /api/sessions/[id]/summary`, the project-attach fan-out
 * and the admin spider. The rest (auto-naming, context summarization, the image/video handlers)
 * publish downstream of a completed chat, which runs its own reservation.
 *
 * A CHECK, not a reservation: settlement moves the balance itself, so reserving here would
 * charge the same work twice. The gap that leaves is the same one every check-then-charge
 * pre-flight in this codebase accepts - it refuses a holder who cannot pay, it does not
 * serialise concurrent requests.
 *
 * Returns a verdict rather than throwing so the fan-out callers, whose primary action is not
 * itself a spend, can skip the queueing without failing the request.
 */
export async function checkSessionOperationalCredits({
  userId,
  operationCount,
  operation,
  logger,
}: SessionOperationalCreditPreflightArgs): Promise<SessionOperationalCreditVerdict> {
  if (operationCount <= 0) return { allowed: true };

  // Gated on the exact pair recordOperationalUsage requires to debit, via the shared helper:
  // operational billing defaults OFF, and a deployment that never bills for this work must not
  // start rejecting it.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: OPERATIONAL_BILLING_SETTING_NAMES, logger }
  );
  if (!isOperationalBillingEnabled(settings)) return { allowed: true };

  // Best-effort resolution, matching the semantic-search pre-flight: a billing-store blip must
  // not turn a working request into a 500. Both assigned only after both reads succeed - a
  // half-resolved pair (user set, org null) would skip the member cap and read the member's
  // personal balance for what is org-billed usage.
  let billingUser: Awaited<ReturnType<typeof userRepository.findById>> | null = null;
  let billingOrg: Awaited<ReturnType<typeof organizationRepository.findById>> | null = null;
  try {
    const resolvedUser = await userRepository.findById(userId);
    const resolvedOrg = resolvedUser?.organizationId
      ? await organizationRepository.findById(resolvedUser.organizationId)
      : null;
    billingUser = resolvedUser;
    billingOrg = resolvedOrg;
  } catch (err) {
    logger?.warn('[sessionOperationalCreditPreflight] failed to resolve user/organization for billing', err);
    return { allowed: true };
  }

  // No user means nothing to attribute or bill: recordSessionOperationalUsage skips the same
  // case, so there is no spend for this gate to guard.
  if (!billingUser) return { allowed: true };

  const requiredCredits = operationCount * MIN_CREDITS_PER_OPERATION;

  // Cap before pool, mirroring deductCreditsWithOrgSupport: a capped member must be refused
  // even when the org pool is flush.
  if (billingOrg && creditService.isMemberCreditCapExceeded(billingOrg, userId, requiredCredits)) {
    return {
      allowed: false,
      reason: `Your organization member credit limit has been reached for ${operation}. Contact your organization administrator.`,
    };
  }

  const availableCredits = (billingOrg ?? billingUser).currentCredits ?? 0;
  if (availableCredits < requiredCredits) {
    return {
      allowed: false,
      reason: billingOrg
        ? `Your organization does not have enough credits for ${operation}. It currently has ${availableCredits} credits and this requires at least ${requiredCredits}.`
        : `You do not have enough credits for ${operation}. You currently have ${availableCredits} credits and this requires at least ${requiredCredits}.`,
    };
  }

  return { allowed: true };
}

/**
 * `checkSessionOperationalCredits` for the entry points whose whole purpose is the operational
 * spend, where a refusal is the answer to the request. Throws a 422 tagged
 * `insufficient_credits` - a billing state, not a bug.
 */
export async function assertSessionOperationalCredits(args: SessionOperationalCreditPreflightArgs): Promise<void> {
  const verdict = await checkSessionOperationalCredits(args);
  if (!verdict.allowed) throw insufficientCreditsError(verdict.reason);
}

/**
 * `checkSessionOperationalCredits` for a fan-out, returning the subset of `sessions` whose owner
 * can pay for the work it would queue.
 *
 * Grouped by session OWNER, not by requester: the session-event handlers bill `session.userId`,
 * and an accessible-not-owned reader (`findAllAccessibleByIds`) lets one request span sessions
 * shared in from several users. One check per distinct owner rather than one per session - the
 * holder document does not change until settlement, so per-session checks would re-read the same
 * verdict N times.
 *
 * Returns rather than throws so a caller whose primary action is free (attaching a notebook to a
 * project) can skip the queueing without failing the request; it logs each refusal so a skipped
 * fan-out is visible to ops rather than silent.
 */
export async function filterSessionIdsByOperationalCredits(
  sessions: Pick<ISessionDocument, 'id' | 'userId'>[],
  { operationsPerSession, operation, logger }: { operationsPerSession: number; operation: string; logger?: Logger }
): Promise<Set<string>> {
  const allowedSessionIds = new Set<string>();
  const sessionIdsByOwner = new Map<string, string[]>();

  for (const session of sessions) {
    // No owner means nothing to attribute or bill, matching recordSessionOperationalUsage's skip.
    if (!session.userId) {
      allowedSessionIds.add(session.id);
      continue;
    }
    const owned = sessionIdsByOwner.get(session.userId);
    if (owned) owned.push(session.id);
    else sessionIdsByOwner.set(session.userId, [session.id]);
  }

  await Promise.all(
    Array.from(sessionIdsByOwner, async ([ownerId, ownedSessionIds]) => {
      const verdict = await checkSessionOperationalCredits({
        userId: ownerId,
        operationCount: ownedSessionIds.length * operationsPerSession,
        operation,
        logger,
      });
      if (verdict.allowed) {
        ownedSessionIds.forEach(sessionId => allowedSessionIds.add(sessionId));
        return;
      }
      logger?.warn(`[sessionOperationalCreditPreflight] skipping ${operation}; owner cannot cover it`, {
        ownerId,
        sessionCount: ownedSessionIds.length,
        reason: verdict.reason,
      });
    })
  );

  return allowedSessionIds;
}
