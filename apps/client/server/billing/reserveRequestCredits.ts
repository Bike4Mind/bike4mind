import { CreditHolderType, IUserDocument, type CreditHoldRecord, type PersistedCreditHold } from '@bike4mind/common';
import {
  creditTransactionRepository,
  organizationRepository,
  pendingCreditHoldRepository,
  usageEventRepository,
  userRepository,
  withTransaction,
  newAccountSpendCapAdapters,
} from '@bike4mind/database';
import { creditService } from '@bike4mind/services';
import type { CreditLedgerEntry } from '@bike4mind/services/creditService';
import type { ILogger } from '@bike4mind/observability';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { assertApiKeyOrgMembership } from '@bike4mind/server-utils/billing/assertApiKeyOrgMembership';

import { resolveRequestBillingOrgId } from '@bike4mind/server-utils/billing/resolveRequestBillingOrgId';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { checkFreeTierDailySpendCap } from './freeTierDailyCapGate';

export { resolveRequestBillingOrgId } from '@bike4mind/server-utils/billing/resolveRequestBillingOrgId';
export type { CreditLedgerEntry };

/**
 * How long a reservation may stay unsettled before apps/workers/src/cron/creditHoldSweep.ts refunds it.
 * Requests still running after this deadline may be refunded by the sweep.
 */
export const CREDIT_HOLD_TTL_MS = 60 * 60_000;

const SETTLEMENT_ATTEMPTS = 3;

export type CreditReservation = {
  ownerId: string;
  ownerType: CreditHolderType;
  /** Credits held against the owner; 0 when nothing was reserved (credits off, or a free request). */
  reservedCredits: number;
  /** The serializable hold, for settling in a later request (see settleHeldCredits); null when nothing was reserved. */
  hold: PersistedCreditHold | null;
  /**
   * Return the whole reservation - the provider call failed and incurred no cost. Never throws: the route
   * is already answering with the provider failure, so a failed refund is logged and left for the sweep
   * rather than replacing that answer with a 500.
   */
  refund(): Promise<void>;
  /**
   * Keep `chargedCredits` (at most the reservation), refund the rest, and write the ledger row.
   * Returns the credits actually charged when confirmed. All writes commit together; an aborted
   * settlement leaves the reservation available for the sweep. Unconfirmed outcomes are logged.
   */
  settle(chargedCredits: number, entry: CreditLedgerEntry): Promise<number>;
};

/** The slice of an authenticated request billing reads. */
type BillingRequest = {
  user?: IUserDocument;
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'billingOwnerType' | 'organizationId'>;
  logger: ILogger;
};

export const holdAdapters = {
  users: userRepository,
  organizations: organizationRepository,
  creditTransactions: creditTransactionRepository,
  deductCredits: creditService.deductCreditsWithOrgSupport,
  newAccountSpendCap: newAccountSpendCapAdapters,
};

type ReserveRequestCreditsParams = {
  req: BillingRequest;
  requiredCredits: number;
  /** The enforceCredits admin setting; unset reads as off, as it always has on these routes. */
  enforceCredits: boolean | undefined;
  /** Noun phrase for the insufficient-credits copy, e.g. "music generation". */
  featureLabel: string;
  /**
   * Route-resolved payer for a browser/JWT caller: an org id bills that org, `null` bills the user,
   * `undefined` keeps the home-org fallback. Ignored for API-key callers, whose target is fixed on
   * the key.
   */
  billingOrganizationId?: string | null;
  /** How long the hold may stay unsettled before the sweep refunds it; defaults to CREDIT_HOLD_TTL_MS. */
  holdTtlMs?: number;
};

/**
 * Reserve a request's cost BEFORE any provider cost is incurred, for the stateless paid API routes
 * (pages/api/ai/music.ts, sound-effects.ts, pages/api/v1/embeddings.ts). The money movement itself
 * lives in creditService/creditHold.ts; this resolves the billing owner and the request-only checks.
 *
 * Billing owner, in precedence order:
 *   1. Org-billed API key -> its organization (billingOwnerType invariant).
 *   2. User-billed API key -> the user (explicit intent; ignore the org seat).
 *   3. Browser/JWT caller -> the route-resolved `billingOrganizationId` when given (null = the
 *      user); else the user's own organization seat if any, matching image/video generation;
 *      otherwise the user.
 * The user always stays the actor for attribution + per-member usage tracking.
 *
 * Gated on enforceCredits, so self-host / credits-off deployments run free; the owner is still
 * resolved so usage events attribute correctly. Throws a 422 `insufficient_credits` when the
 * member cap or the pool cannot cover the reservation.
 */
export async function reserveRequestCredits({
  req,
  requiredCredits,
  enforceCredits,
  featureLabel,
  billingOrganizationId: explicitBillingOrgId,
  holdTtlMs = CREDIT_HOLD_TTL_MS,
}: ReserveRequestCreditsParams): Promise<CreditReservation> {
  if (!req.user) throw new BadRequestError('User not found');
  // Before the enforceCredits short-circuit: a moderated user is refused with credits on or off.
  assertAiAccessAllowed(req.user);
  const userId = req.user.id;
  const billingOrganizationId = resolveRequestBillingOrgId(req, explicitBillingOrgId);
  const ownerId = billingOrganizationId ?? userId;
  const ownerType = billingOrganizationId ? CreditHolderType.Organization : CreditHolderType.User;

  // Daily cap check for free-tier accounts (no-op when enforceCredits is off).
  await checkFreeTierDailySpendCap({
    user: req.user,
    req,
    billingOrganizationId,
    usageEventRepository,
    logger: req.logger,
  });

  if (!enforceCredits || requiredCredits <= 0) {
    return { ownerId, ownerType, reservedCredits: 0, hold: null, refund: async () => {}, settle: async () => 0 };
  }

  // One transaction, so the balance never moves without a pending row the sweep can find, and a row
  // never exists for a balance that did not move.
  const { hold, pending } = await withTransaction(async () => {
    const hold = await creditService.holdCredits(
      {
        userId,
        organizationId: billingOrganizationId ?? null,
        requiredCredits,
        featureLabel,
        logger: req.logger,
        // Re-checked against the roster holdCredits just fetched - no extra query.
        assertBillable: (billingUser, billingOrg) =>
          assertApiKeyOrgMembership({ billingOrg, billingUser, isApiKeyCaller: Boolean(req.apiKeyInfo) }),
      },
      holdAdapters
    );
    const expiresAt = new Date(Date.now() + holdTtlMs);
    return { hold, pending: await pendingCreditHoldRepository.record(hold, featureLabel, expiresAt) };
  });

  return {
    ownerId: hold.ownerId,
    ownerType: hold.ownerType,
    reservedCredits: hold.reservedCredits,
    hold: { ...hold, pendingHoldId: pending.id },
    refund: () => releaseHeldCredits({ ...hold, pendingHoldId: pending.id }, { featureLabel, logger: req.logger }),
    settle: (chargedCredits, entry) =>
      settlePendingHold(hold, pending.id, chargedCredits, entry, { featureLabel, logger: req.logger }),
  };
}

/** Claim and refund together; a failed refund stays pending for the sweep. Never throws. */
export async function releaseHeldCredits(
  { pendingHoldId, ...hold }: PersistedCreditHold,
  { featureLabel, logger }: { featureLabel: string; logger: ILogger }
): Promise<void> {
  try {
    if (!pendingHoldId) {
      await creditService.releaseCreditHold(hold, holdAdapters);
      return;
    }
    const refunded = await withTransaction(async () => {
      if (!(await pendingCreditHoldRepository.claim(pendingHoldId))) return false;
      await creditService.releaseCreditHold(hold, holdAdapters);
      return true;
    });
    if (!refunded) {
      logger.warn(`${featureLabel} refund found its credit hold already swept`, { holdId: pendingHoldId });
    }
  } catch (error) {
    logger.error(`${featureLabel} refund failed - left for the expired-hold sweep`, {
      holdId: pendingHoldId,
      ownerId: hold.ownerId,
      ownerType: hold.ownerType,
      reservedCredits: hold.reservedCredits,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function holdErrorLogger(logger: ILogger, featureLabel: string, hold: CreditHoldRecord, pendingHoldId: string) {
  return (message: string, err?: unknown) =>
    logger.error(`${featureLabel} ${message}`, {
      holdId: pendingHoldId,
      ownerId: hold.ownerId,
      ownerType: hold.ownerType,
      reservedCredits: hold.reservedCredits,
      ...(err === undefined ? {} : { error: err instanceof Error ? err.message : 'Unknown error' }),
    });
}

/**
 * Settle `hold` through its pending row: marking the row settled commits with the partial refund,
 * member usage and ledger row, and the sweep refunds only a row it can claim, so exactly one of
 * them moves balance. Returns the credits charged; 0 when the sweep already refunded the hold.
 */
async function settlePendingHold(
  hold: CreditHoldRecord,
  pendingHoldId: string,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  { featureLabel, logger, throwOnUnconfirmed }: { featureLabel: string; logger: ILogger; throwOnUnconfirmed?: boolean }
): Promise<number> {
  const logHoldError = holdErrorLogger(logger, featureLabel, hold, pendingHoldId);
  const charged = Number.isFinite(chargedCredits)
    ? Math.min(Math.max(chargedCredits, 0), hold.reservedCredits)
    : hold.reservedCredits;
  for (let attempt = 1; ; attempt++) {
    try {
      // A process death or failed write leaves either the original refundable hold or the completed settlement.
      return await withTransaction(async () => {
        if (!(await pendingCreditHoldRepository.markSettled(pendingHoldId, charged))) {
          const settled = await pendingCreditHoldRepository.findSettlement(pendingHoldId);
          if (settled !== null) return settled;
          logHoldError('settle found its credit hold already swept - request not charged');
          return 0;
        }
        return creditService.settleCreditHold(
          hold,
          chargedCredits,
          entry,
          { featureLabel, logger, throwOnWriteFailure: true },
          holdAdapters
        );
      });
    } catch (err) {
      // A commit can succeed while its acknowledgement is lost. Never infer a refund from a
      // missing claim: the durable receipt tells us whether this settlement already committed.
      try {
        const settled = await pendingCreditHoldRepository.findSettlement(pendingHoldId);
        if (settled !== null) return settled;
      } catch (reconcileError) {
        logHoldError('settle could not read its settlement receipt', reconcileError);
      }
      if (attempt >= SETTLEMENT_ATTEMPTS) {
        logHoldError('settle could not confirm outcome - any pending hold remains refundable', err);
        if (throwOnUnconfirmed) throw err;
        return 0;
      }
    }
  }
}

/**
 * Settle a hold persisted by an earlier request (e.g. an async batch settled on poll). Same clamp,
 * ledger and sweep-claim semantics as CreditReservation.settle; a charge of 0 refunds the whole hold.
 */
export function settleHeldCredits(
  persisted: PersistedCreditHold,
  chargedCredits: number,
  entry: CreditLedgerEntry,
  context: {
    featureLabel: string;
    logger: ILogger;
    /** Async callers can retry later; keep their durable work unsettled on an unconfirmed outcome. */
    throwOnUnconfirmed?: boolean;
  }
): Promise<number> {
  const { pendingHoldId, ...hold } = persisted;
  // Held before pending rows existed: nothing for the sweep to refund, so settle directly.
  if (!pendingHoldId) return creditService.settleCreditHold(hold, chargedCredits, entry, context, holdAdapters);
  return settlePendingHold(hold, pendingHoldId, chargedCredits, entry, context);
}
