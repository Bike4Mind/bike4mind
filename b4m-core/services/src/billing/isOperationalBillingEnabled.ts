import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { IAdminSettingsRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** The settings store this helper reads, narrowed to what `getSettingsMap` needs. */
export type OperationalBillingSettingsAdapter = {
  adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
};

/**
 * Whether operational usage (auto-naming, summarization, tagging, embeddings for
 * search) actually debits credits on this deployment. Both gates must be on:
 * `billOperationalUsage` opts this class of spend in, `enforceCredits` is the
 * platform-wide metering master switch (off on self-host).
 *
 * Shared by `recordOperationalUsage` (the settlement) and every credit pre-flight
 * that guards a path settling through it, so the two provably agree on when a debit
 * can happen. They MUST stay in sync: a pre-flight stricter than the settlement
 * rejects work that would never have been billed, and a looser one leaves the gap
 * the pre-flight exists to close.
 *
 * Owns the fetch rather than taking a settings map, so no caller can narrow it to the
 * wrong keys: `getSettingsMap`'s `names` option is honoured only under `skipCache`
 * (`b4m-core/utils/src/settings.ts:130-143`), so a named fetch is inert on the cached
 * path and, on a `skipCache` path, one that omits a key reads `undefined` for it and
 * silently gates billing OFF - turning a pre-flight into a no-op with no error anywhere.
 *
 * Throws if the settings store does: a caller that must not fail on a billing-store
 * blip has to catch this and decide its own fallback.
 */
export async function isOperationalBillingEnabled(
  db: OperationalBillingSettingsAdapter,
  logger?: Logger
): Promise<boolean> {
  const settings = await getSettingsMap(db, { logger });
  return (
    (getSettingsValue('billOperationalUsage', settings) ?? false) &&
    (getSettingsValue('enforceCredits', settings) ?? false)
  );
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
  const settings = await getSettingsMap(db, { logger });
  return getSettingsValue('enforceCredits', settings) ?? false;
}
