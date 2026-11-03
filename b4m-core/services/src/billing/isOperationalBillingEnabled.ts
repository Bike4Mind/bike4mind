import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { IAdminSettingsRepository, IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** The settings store this helper reads, narrowed to what `getSettingsMap` needs. */
export type OperationalBillingSettingsAdapter = {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
};

/** Whether a user holds an active plan, their own or an org seat. Wired by the app tier. */
export type ActivePlanResolver = { hasActivePlan(userId: string): Promise<boolean> };

/** The account an operational charge would land on; `organization` set means the org pool pays. */
export type OperationalBillingHolder = {
  user: Pick<IUserDocument, 'id' | 'lastCreditsPurchasedAt'>;
  organization?: Pick<IOrganizationDocument, 'id'> | null;
  activePlans: ActivePlanResolver;
};

/**
 * A user paying for themselves with no credit purchase and no active plan (own or an org seat):
 * the paid signals the API key trust gate reads (userApiKeyService/trust.ts), plan read lazily as
 * there. Org-paid spend is never free tier, since no org-level signal says whether the pool is funded.
 */
export async function isFreeTierHolder(holder: OperationalBillingHolder): Promise<boolean> {
  if (holder.organization || holder.user.lastCreditsPurchasedAt) return false;
  return !(await holder.activePlans.hasActivePlan(holder.user.id));
}

/** `isOperationalBillingEnabled` bound to one settings store; see memoizeOperationalBillingCheck. */
export type OperationalBillingCheck = (holder?: OperationalBillingHolder) => Promise<boolean>;

/**
 * One request's or turn's view of `isOperationalBillingEnabled`: the settings and plan reads run
 * at most once per holder, so repeated spend in the same unit of work does not repeat them. A
 * rejected read is not kept. Never share one across requests: it would pin a stale answer.
 */
export function memoizeOperationalBillingCheck(
  db: OperationalBillingSettingsAdapter,
  logger?: Logger
): OperationalBillingCheck {
  const memo = new Map<string, Promise<boolean>>();
  return holder => {
    const key = holder ? `${holder.user.id}:${holder.organization?.id ?? ''}` : '';
    let pending = memo.get(key);
    if (!pending) {
      pending = isOperationalBillingEnabled(db, logger, holder);
      memo.set(key, pending);
      pending.catch(() => memo.delete(key));
    }
    return pending;
  };
}

/**
 * Whether operational usage (auto-naming, summarization, tagging, embeddings for search and file
 * indexing) actually debits credits. Requires `enforceCredits`, the platform-wide metering master
 * switch (off on self-host). On top of it, `billOperationalUsage` opts every holder in; with it
 * off, only a free-tier `holder` is billed. Without a `holder` the free-tier carve-out cannot
 * apply, so the answer is the toggle alone.
 *
 * Shared by `recordOperationalUsage` (the settlement) and every credit pre-flight that guards a
 * path settling through it, so the two provably agree on when a debit can happen. They MUST stay
 * in sync, including passing the same holder: a pre-flight stricter than the settlement rejects
 * work that would never have been billed, and a looser one leaves the gap the pre-flight exists
 * to close.
 *
 * Owns the fetch rather than taking a settings map, so no caller can narrow it to the
 * wrong keys: under `skipCache` a `names` list that omits a key reads `undefined` for
 * it and silently gates billing OFF - turning a pre-flight into a no-op with no error
 * anywhere. `skipCache` is required for the same reason: a long-lived host's process
 * cache can lag another process's admin write until its TTL expires.
 *
 * Throws if the settings store or the plan read does: a caller that must not fail on a
 * billing-store blip has to catch this and decide its own fallback.
 */
export async function isOperationalBillingEnabled(
  db: OperationalBillingSettingsAdapter,
  logger?: Logger,
  holder?: OperationalBillingHolder
): Promise<boolean> {
  const settings = await getSettingsMap(db, {
    logger,
    // Both keys the caller could narrow away are listed here; the read bypasses the process
    // cache so an admin flip is honoured on the next call rather than after the TTL.
    names: ['billOperationalUsage', 'enforceCredits'],
    skipCache: true,
  });
  if (!(getSettingsValue('enforceCredits', settings) ?? false)) return false;
  if (getSettingsValue('billOperationalUsage', settings) ?? false) return true;
  return holder ? isFreeTierHolder(holder) : false;
}

/**
 * Whether this deployment meters credits at all - the `enforceCredits` master switch alone (off on
 * self-host, where there is no billing stack), WITHOUT the `billOperationalUsage` policy on top.
 *
 * For spend that is billed on its own terms rather than by that policy: data-lake research judge
 * calls are charged to the lake owner because a manager can start a run on a per-run ceiling, which
 * `billOperationalUsage` was never meant to govern (it names auto-naming, summarization, tagging and
 * KB search embeddings). The research pre-flight and settlement MUST both key off this one function
 * for the same reason `isOperationalBillingEnabled` exists - a pre-flight stricter than the
 * settlement refuses work that would never have been charged.
 *
 * Still respects `enforceCredits`: on a deployment that does not meter credits, research must not
 * debit a ledger that does not exist, so it is recorded as platform cost exactly as today.
 * Throws if the settings store does, matching `isOperationalBillingEnabled`.
 */
export async function areCreditsEnforced(db: OperationalBillingSettingsAdapter, logger?: Logger): Promise<boolean> {
  // Same cross-process staleness as isOperationalBillingEnabled: this gates a forced debit.
  const settings = await getSettingsMap(db, { logger, names: ['enforceCredits'], skipCache: true });
  return getSettingsValue('enforceCredits', settings) ?? false;
}
