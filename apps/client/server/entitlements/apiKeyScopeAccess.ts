import { hasDeveloperUserTag, settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingByName } from '@bike4mind/utils';
import type { ApiKeyScopeAccess } from '@client/app/constants/apiKeyScopes';
import { isSettingEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { getRequestEntitlements, type EntitlementRequest } from './index';

/**
 * Server half of useApiKeyScopeAccess: the same product gates the scoped routes apply to a key's
 * owner, resolved for the minting user so a key cannot be minted with a scope the UI hid.
 * Admin and developer bypass the entitlement arms, matching the overlays' access predicates.
 */
export async function resolveApiKeyScopeAccess(req: EntitlementRequest): Promise<ApiKeyScopeAccess> {
  const bypass = !!req.user?.isAdmin || hasDeveloperUserTag(req.user?.tags);
  const [entitlements, hearthSetting] = await Promise.all([
    bypass ? Promise.resolve([]) : getRequestEntitlements(req),
    getSettingByName('EnableHearth', { adminSettings: adminSettingsRepository }),
  ]);
  return {
    hasOptiAccess: bypass || entitlements.includes('optihashi:pro'),
    hasOverwatchAccess: bypass || entitlements.includes('overwatch:pro'),
    hearthEnabled: isSettingEnabled(hearthSetting ?? settingsMap.EnableHearth?.defaultValue),
  };
}
