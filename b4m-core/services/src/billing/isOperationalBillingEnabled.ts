import { getSettingsValue } from '@bike4mind/utils';
import type { IAdminSettings } from '@bike4mind/common';

/**
 * The settings a caller must fetch for `isOperationalBillingEnabled` to answer
 * correctly. Pass this to `getSettingsMap({ names })` rather than hand-listing the
 * keys: a named fetch that omits one of them reads `undefined` for it and silently
 * gates billing OFF, which turns a pre-flight into a no-op with no error anywhere.
 */
export const OPERATIONAL_BILLING_SETTING_NAMES: IAdminSettings['settingName'][] = [
  'billOperationalUsage',
  'enforceCredits',
];

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
 */
export function isOperationalBillingEnabled(settings: Record<string, string>): boolean {
  return (
    (getSettingsValue('billOperationalUsage', settings) ?? false) &&
    (getSettingsValue('enforceCredits', settings) ?? false)
  );
}
