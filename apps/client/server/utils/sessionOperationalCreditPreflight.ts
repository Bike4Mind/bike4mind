import { insufficientCreditsError, type ISessionDocument, type ModelInfo } from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { creditService, isOperationalBillingEnabled } from '@bike4mind/services';
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
 *
 * A floor and a proxy both have the same hole: work whose real settlement is always zero. That is
 * why a refusal is not final until `operationalSpendSettlesFree` has ruled the model out.
 */
const MIN_CREDITS_PER_OPERATION = 1;

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
  /**
   * Who is asking, when the caller knows. Decides how much of the refusal is safe to say:
   * `pushShareable` shares by bare userId with no org constraint, so a requester holding
   * update on a shared session can be outside the holder's organization entirely. Second
   * person ("Your organization ... has 37 credits") would then both address the wrong party
   * and disclose another tenant's balance, so a non-holder gets an impersonal reason with no
   * figures. Omit it on a path whose reason never reaches a client (the fan-out logs its
   * refusals for ops, where the figures are the point).
   */
  requesterId?: string;
  /** Named in the refusal message, e.g. 'session tagging'. */
  operation: string;
  logger?: Logger;
}

/** Discriminated so a caller that must not fail its primary action can branch on the reason. */
export type SessionOperationalCreditVerdict = { allowed: true } | { allowed: false; reason: string };

type BillingUser = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;
type BillingOrg = Awaited<ReturnType<typeof organizationRepository.findById>>;

/**
 * Whether the model this work will run on settles at zero credits for ANY token volume, which
 * makes the nominal floor above the wrong question to ask. `freeToRun` is the codebase's only
 * declaration of that: the backends that publish zero rates deliberately set it
 * (ollamaBackend.ts:122, localImageBackend.ts:68), `generateModelPriceSeed.ts:47` skips seeding
 * price rows for a model carrying it, and `getTextModelCost` reads it to decide that $0 on real
 * usage is intent rather than a gap (models.ts:646-654).
 *
 * The same carve-out the sibling pre-flight makes on `embeddingCostUsd > 0`
 * (pages/api/data-lakes/semantic-search.ts:438). That one can price the exact call because the
 * token count is known at request time; here it is not, so the question is asked one level up:
 * not "what will this cost" but "is this model declared costless".
 *
 * An empty or all-zero `pricing` map is deliberately NOT accepted as that declaration, even
 * though `getTextModelCost` would return $0 for it. Both write paths reject that state outright
 * with "mark the model freeToRun instead" (ModelPriceModel.ts:91-98, model-prices.ts:213-216)
 * and modelCatalog.ts:78-81 calls it the intended fail-loud signal, so it only ever reaches a
 * reader as a gap: price-seed lag, or the per-process `_modelCache` serving this process a map
 * the SessionEvents process already prices from. Inferring "free" from it would waive the charge
 * here while settlement debits normally - and this pre-flight is the sole `maxCreditsPerMember`
 * enforcement point on these paths (recordOperationalUsage.ts:84-88), so a false waive costs
 * more than the ordinary fail-open elsewhere in this file.
 */
function settlesFreeForAnyVolume(modelInfo: Pick<ModelInfo, 'freeToRun'>): boolean {
  return modelInfo.freeToRun === true;
}

/**
 * Resolved through the same `getOperationsModel()` the handlers themselves call
 * (sessionSummarization.ts:64, sessionTagging.ts:115) so the gate and the charge cannot disagree
 * about which model is in play.
 *
 * Imported dynamically and reached only on a would-be refusal: it reads an admin setting and
 * builds the whole model catalog, far too much work to spend on the happy path confirming what
 * the priced default (`gpt-4o-mini`) already implies. A resolution failure keeps the refusal
 * rather than fail-opening like the reads above - those cannot produce a verdict at all without
 * succeeding, whereas here a verdict already exists and "priced" is the accurate default.
 */
async function operationalSpendSettlesFree(logger?: Logger): Promise<boolean> {
  try {
    const { OperationsModelService } = await import('@client/services/operationsModelService');
    const { modelInfo } = await OperationsModelService.getOperationsModel();
    return settlesFreeForAnyVolume(modelInfo);
  } catch (err) {
    logger?.warn(
      '[sessionOperationalCreditPreflight] failed to resolve the operations model; keeping the refusal',
      err
    );
    return false;
  }
}

/** The refusal this holder's balance earns, or null when it covers `requiredCredits`. */
function resolveRefusalReason({
  billingUser,
  billingOrg,
  userId,
  requiredCredits,
  requesterIsHolder,
  operation,
}: {
  billingUser: BillingUser;
  billingOrg: BillingOrg;
  userId: string;
  requiredCredits: number;
  requesterIsHolder: boolean;
  operation: string;
}): string | null {
  const crossHolderReason = `The owner of this notebook does not have enough credits for ${operation}.`;

  // Cap before pool, mirroring deductCreditsWithOrgSupport: a capped member must be refused
  // even when the org pool is flush.
  if (billingOrg && creditService.isMemberCreditCapExceeded(billingOrg, userId, requiredCredits)) {
    // "Contact your organization administrator" is only actionable for a member of that org.
    return requesterIsHolder
      ? `Your organization member credit limit has been reached for ${operation}. Contact your organization administrator.`
      : crossHolderReason;
  }

  const availableCredits = (billingOrg ?? billingUser).currentCredits ?? 0;
  if (availableCredits >= requiredCredits) return null;
  if (!requesterIsHolder) return crossHolderReason;
  return billingOrg
    ? `Your organization does not have enough credits for ${operation}. It currently has ${availableCredits} credits and this requires at least ${requiredCredits}.`
    : `You do not have enough credits for ${operation}. You currently have ${availableCredits} credits and this requires at least ${requiredCredits}.`;
}

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
  requesterId,
  logger,
}: SessionOperationalCreditPreflightArgs): Promise<SessionOperationalCreditVerdict> {
  if (operationCount <= 0) return { allowed: true };

  // Gated on the exact pair recordOperationalUsage requires to debit, via the shared helper:
  // operational billing defaults OFF, and a deployment that never bills for this work must not
  // start rejecting it. Inside the fail-open boundary like the reads below: AdminSettingsCache
  // awaits findAll() on a cache miss with no error handling of its own, so a cold container or
  // a TTL expiry during a mongo blip would otherwise reject - and on the project-attach path
  // that lands after withTransaction has already committed.
  try {
    const billingEnabled = await isOperationalBillingEnabled({ adminSettings: adminSettingsRepository }, logger);
    if (!billingEnabled) return { allowed: true };
  } catch (err) {
    logger?.warn('[sessionOperationalCreditPreflight] failed to read billing settings', err);
    return { allowed: true };
  }

  // Best-effort resolution, matching the semantic-search pre-flight: a billing-store blip must
  // not turn a working request into a 500. Both assigned only after both reads succeed - a
  // half-resolved pair (user set, org null) would skip the member cap and read the member's
  // personal balance for what is org-billed usage.
  let billingUser: BillingUser | null = null;
  let billingOrg: BillingOrg = null;
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

  // Everything second-person, and every figure, is scoped to the requester being the holder.
  // A caller that cannot say who is asking is treated as the holder, which is the pre-existing
  // wording; the entry points that can face a cross-tenant share all pass requesterId.
  const requesterIsHolder = requesterId === undefined || requesterId === userId;

  const refusalReason = resolveRefusalReason({
    billingUser,
    billingOrg,
    userId,
    requiredCredits,
    requesterIsHolder,
    operation,
  });
  if (!refusalReason) return { allowed: true };

  // Last question before refusing, and only worth asking here: MIN_CREDITS_PER_OPERATION is a
  // nominal proxy for a cost that can legitimately be zero, and a 422 on free work is a
  // regression against the ungated behavior this replaced.
  if (await operationalSpendSettlesFree(logger)) {
    logger?.info(
      `[sessionOperationalCreditPreflight] allowing ${operation} despite the balance; the operations model settles free`
    );
    return { allowed: true };
  }

  return { allowed: false, reason: refusalReason };
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
 *
 * Each REFUSED owner costs one operations-model resolution (see `operationalSpendSettlesFree`),
 * so a batch where every owner is broke pays for one per owner rather than one per request. Left
 * uncached deliberately: the owner count per attach is small, the checks run concurrently, and a
 * module-level cache would put a staleness window on a billing-adjacent read to save work that
 * only happens when the request is being refused anyway.
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
