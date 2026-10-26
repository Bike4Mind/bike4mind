import { partitionDomainList, settingsMap } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { AdminSettings } from '@bike4mind/database/infra';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { recordAdminSettingChange } from '@server/utils/adminSettingsAudit';
import { assertOwnedDomain } from './assertOwnedDomain';

type AuditRequest = Parameters<typeof recordAdminSettingChange>[0];

const SETTING = 'blockedEmailDomains';

/**
 * Adds a domain to the blockedEmailDomains setting so the registration gate refuses new signups on
 * it. The second writer of that setting after pages/api/settings/update.ts: same normalization and
 * public-suffix refusal, same strict audit entry in the write's transaction, same cache invalidation after the commit.
 * Returns false when the domain was already listed.
 */
export async function addBlockedEmailDomain(req: AuditRequest, rawDomain: string): Promise<boolean> {
  const domain = assertOwnedDomain(rawDomain);

  const added = await withTransaction(async () => {
    const existing = await AdminSettings.findOne({ settingName: SETTING }).lean();
    const parsed = settingsMap[SETTING].schema.safeParse(existing?.settingValue);
    const current = partitionDomainList(parsed.success ? parsed.data : []).valid;
    if (current.includes(domain)) return false;

    const next = [...current, domain];
    await AdminSettings.findOneAndUpdate({ settingName: SETTING }, { $set: { settingValue: next } }, { upsert: true });
    await recordAdminSettingChange(req, {
      settingName: SETTING,
      before: existing?.settingValue ?? null,
      after: next,
      summary: `blocked signups from ${domain} in a bulk abuse response`,
    });
    return true;
  });

  if (added) invalidateSettingsCache(SETTING);
  return added;
}
