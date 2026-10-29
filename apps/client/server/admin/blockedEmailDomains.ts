import { isDomainInDomains, partitionDomainList, settingsMap } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { recordAdminSettingChange } from '@server/utils/adminSettingsAudit';
import { assertOwnedDomain } from './bulkAbuse/assertOwnedDomain';

type AuditRequest = Parameters<typeof recordAdminSettingChange>[0];

const SETTING = 'blockedEmailDomains';

const listedDomains = (settingValue: unknown): string[] => {
  const parsed = settingsMap[SETTING].schema.safeParse(settingValue);
  return partitionDomainList(parsed.success ? parsed.data : []).valid;
};

/** The current blockedEmailDomains list, normalized. Reads only. */
export async function readBlockedEmailDomains(): Promise<Set<string>> {
  const existing = await AdminSettings.findOne({ settingName: SETTING }).lean();
  return new Set(listedDomains(existing?.settingValue));
}

/**
 * Rewrites blockedEmailDomains with `change` applied, in one transaction with its strict audit
 * entry, then drops the settings cache. The writers after pages/api/settings/update.ts share it, so
 * they keep the same normalization and audit. Returns the domains actually added or removed.
 */
async function rewriteBlockedEmailDomains(
  req: AuditRequest,
  change: (current: string[]) => { next: string[]; changed: string[] },
  summaryFor: (changed: string[]) => string
): Promise<string[]> {
  const changed = await withTransaction(async () => {
    const existing = await AdminSettings.findOne({ settingName: SETTING }).lean();
    const { next, changed } = change(listedDomains(existing?.settingValue));
    if (changed.length === 0) return changed;

    await AdminSettings.findOneAndUpdate({ settingName: SETTING }, { $set: { settingValue: next } }, { upsert: true });
    await recordAdminSettingChange(req, {
      settingName: SETTING,
      before: existing?.settingValue ?? null,
      after: next,
      summary: summaryFor(changed),
    });
    return changed;
  });

  if (changed.length > 0) invalidateSettingsCache(SETTING);
  return changed;
}

/**
 * Adds the domains so the registration gate refuses new signups on them. Each must be an owned
 * domain (assertOwnedDomain: no public suffix, no public mailbox provider). A domain already
 * covered by the list, itself or through a parent, is skipped. Returns the domains added.
 */
export async function addBlockedEmailDomains(
  req: AuditRequest,
  rawDomains: readonly string[],
  summaryFor: (added: string[]) => string
): Promise<string[]> {
  const domains = [...new Set(rawDomains.map(assertOwnedDomain))];
  return rewriteBlockedEmailDomains(
    req,
    current => {
      const listed = new Set(current);
      // The registration gate matches subdomains, so a listed parent already blocks the domain.
      const added = domains.filter(domain => !isDomainInDomains(domain, listed));
      return { next: [...current, ...added], changed: added };
    },
    summaryFor
  );
}

/** Removes exactly these domains (never a parent that covers them). Returns the domains removed. */
export async function removeBlockedEmailDomains(
  req: AuditRequest,
  domains: readonly string[],
  summaryFor: (removed: string[]) => string
): Promise<string[]> {
  const toRemove = new Set(domains);
  return rewriteBlockedEmailDomains(
    req,
    current => ({
      next: current.filter(domain => !toRemove.has(domain)),
      changed: current.filter(domain => toRemove.has(domain)),
    }),
    summaryFor
  );
}
