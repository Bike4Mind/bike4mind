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
 * makes the nominal floor above the wrong question to ask. Two conditions, and both are
 * load-bearing, because neither alone means "settlement will charge nothing":
 *
 * 1. `freeToRun` is the codebase's only DECLARATION of costless intent: the backends that
 *    publish zero rates deliberately set it (ollamaBackend.ts:122, localImageBackend.ts:68) and
 *    `generateModelPriceSeed.ts:49` skips seeding price rows for a model carrying it. It is an
 *    annotation, though, not a billing switch - `getTextModelCost` reads it ONLY to suppress the
 *    `[UNPRICED_MODEL]` alarm (models.ts:678-686), never to force a zero, and no write path
 *    stops a `freeToRun` model from also carrying a priced tier (the discovery append at
 *    runModelDiscovery.ts:999 bypasses the admin route's known-model gate). The flag alone would
 *    therefore waive the gate on work that settlement then charges in full.
 * 2. So the model's own price map has to agree, on EVERY tier. Pricing one large sample volume
 *    would not: `tierForTokens` selects by input tokens and falls back to the WIDEST tier rather
 *    than returning null (models.ts:692-697), so a sample reads whichever tier is widest and says
 *    nothing about the narrower one a real operational call lands in. `{128000: {input: 0.15,
 *    output: 0.6}, 2000000: {input: 0, output: 0}}` prices free at 1M and charges a 10k call in
 *    full. Reading every tier is also what covers the cache legs, which settlement passes real
 *    counts for (recordSessionOperationalUsage.ts:63) and a sample priced at zero cache tokens
 *    never exercises.
 *
 * Checking the map directly rather than calling `getTextModelCost` also keeps this total and
 * side-effect free: there is no volume to choose, and no way for the check to raise the
 * `[UNPRICED_MODEL]` alarm that a computed zero would.
 *
 * The same carve-out the sibling pre-flight makes on `embeddingCostUsd > 0`
 * (pages/api/data-lakes/semantic-search.ts:486). That one can price the exact call because the
 * token count is known at request time; here it is not, so the question is asked of the price
 * map at model granularity instead.
 *
 * An empty or all-zero `pricing` map is deliberately NOT accepted as the declaration on its own,
 * even though an empty map satisfies the every-tier test vacuously. Both write paths reject that
 * state outright with "mark the model freeToRun instead" (ModelPriceModel.ts:91-98,
 * model-prices.ts:213-216)
 * and modelCatalog.ts:78-81 calls it the intended fail-loud signal, so it only ever reaches a
 * reader as a gap: price-seed lag, or the per-process `_modelCache` serving this process a map
 * the SessionEvents process already prices from. Inferring "free" from it would waive the charge
 * here while settlement debits normally - and this pre-flight is the sole `maxCreditsPerMember`
 * enforcement point on these paths (recordOperationalUsage.ts:84-88), so a false waive costs
 * more than the ordinary fail-open elsewhere in this file. Requiring the flag is what keeps that
 * gap out; requiring every tier to be zero is what keeps a mislabelled model from exploiting
 * the flag.
 */
function settlesFreeForAnyVolume(modelInfo: ModelInfo): boolean {
  return (
    modelInfo.freeToRun === true &&
    Object.values(modelInfo.pricing).every(
      tier => tier.input === 0 && tier.output === 0 && !tier.cache_read && !tier.cache_write
    )
  );
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

  // Cap before pool: a capped member must be refused even when the org pool is flush. Mirrors
  // the RESERVATION pre-flights, which are the only place the cap is ever enforced -
  // semantic-search.ts:496 and music.ts:129 in this app, ChatCompletionProcess.ts:3661 and
  // cliCompletions.ts:380 in core. Deliberately NOT deductCreditsWithOrgSupport: that is the
  // settlement write and it documents at :168-172 why it runs no cap check of its own (throwing
  // there cannot block an already-served request, and would freeze `usedCredits` so the cap
  // could never trip again). That is the same reason the cap cannot live in
  // recordOperationalUsage, and therefore the reason this pre-flight exists.
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
    // error, not warn: the fail-open is correct but it means the gate stopped enforcing, which is
    // indistinguishable from the ungated behavior it replaced. These two strings are the only
    // evidence that happened, so they are deliberately distinctive enough to hang a
    // LogMetricFilter alarm on without touching this code (infra/alarms.ts:807).
    logger?.error('[sessionOperationalCreditPreflight] gate disabled: failed to read billing settings', err);
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
    logger?.error(
      '[sessionOperationalCreditPreflight] gate disabled: failed to resolve user/organization for billing',
      err
    );
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
    // warn, not info: a waived refusal is the designed path, but it is still a refusal this gate
    // declined to enforce, and the operations model being costless is worth seeing when someone
    // asks why a zero-balance account is running summaries.
    logger?.warn(
      `[sessionOperationalCreditPreflight] waiving ${operation} refusal; the operations model settles free at any volume`
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
 * Per owner, not per request: one settings read (cheap after the first - AdminSettingsCache holds
 * it in process, though concurrent first-callers on a cold container can each miss) plus, for a
 * REFUSED owner only, one operations-model resolution (see `operationalSpendSettlesFree`). Left
 * uncached beyond that deliberately: the owner count per attach is bounded by the notebooks being
 * attached, the checks run concurrently, and a module-level cache would put a staleness window on
 * a billing-adjacent read to save work that only happens when the request is being refused anyway.
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
