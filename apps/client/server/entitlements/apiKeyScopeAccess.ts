import { hasDeveloperUserTag, settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingByName } from '@bike4mind/utils';
import type { ApiKeyScopeAccess } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { isSettingEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { getRequestEntitlements, getUserEntitlements, type EntitlementRequest, type EntitlementUser } from './index';

/**
 * Server half of useApiKeyScopeAccess: the same product gates the scoped routes apply to a key's
 * owner, resolved for the minting user so a key cannot be minted with a scope the UI hid.
 * Admin and developer bypass the entitlement arms, matching the overlays' access predicates, and
 * skip the entitlement lookup, so `entitlements` is empty for them.
 */
export async function resolveApiKeyScopeAccess(req: EntitlementRequest): Promise<ApiKeyScopeAccess> {
  return resolveAccess(req.user, () => getRequestEntitlements(req));
}

/** resolveApiKeyScopeAccess for a user other than the caller, e.g. the target of an admin mint. */
export async function resolveApiKeyScopeAccessForUser(user: EntitlementUser): Promise<ApiKeyScopeAccess> {
  return resolveAccess(user, () => getUserEntitlements(user));
}

async function resolveAccess(
  user: Pick<EntitlementUser, 'isAdmin' | 'tags'> | undefined,
  loadEntitlements: () => Promise<string[]>
): Promise<ApiKeyScopeAccess> {
  const bypass = !!user?.isAdmin || hasDeveloperUserTag(user?.tags);
  const [entitlements, hearthSetting] = await Promise.all([
    bypass ? Promise.resolve([]) : loadEntitlements(),
    getSettingByName('EnableHearth', { adminSettings: adminSettingsRepository }),
  ]);
  return {
    hasOptiAccess: bypass || entitlements.includes('optihashi:pro'),
    hasOverwatchAccess: bypass || entitlements.includes('overwatch:pro'),
    hearthEnabled: isSettingEnabled(hearthSetting ?? settingsMap.EnableHearth?.defaultValue),
    bypass,
    entitlements: new Set(entitlements),
  };
}
