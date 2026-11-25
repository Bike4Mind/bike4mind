import { IOrganizationRepository, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

interface ResolveOwnedApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
  /**
   * Resolve an org-owned key (`orgOwned`) too. Only the org key routes
   * (pages/api/organizations/[id]/api-keys/*) pass it, after authorizing the caller and recording an
   * `org.api_key.*` audit row; every other caller treats an org-owned key as not found.
   */
  includeOrgOwned?: boolean;
}

/**
 * Single source for the "minter, or admin of the org the key is billed to"
 * resolution shared by revoke/rotate/updateEmbedKey and the [id] route's
 * branding-owner read. Returns the hydrated doc as-is (never serialized); writers
 * never write the whole doc back (a targeted db.userApiKeys.update({ id, ...patch }),
 * or revokeIfNotDisabled for revoke), so a concurrent revoke or spend $inc isn't reverted. The minter
 * lookup is tried first and the org-admin fallback only runs on a miss, so
 * the minter path pays no extra query - preserve that order in any caller.
 *
 * Deliberately NOT used by rateLimit.ts or spendCap.ts, which are
 * minter-only by design (see rateLimit.ts's own docstring) - do not widen
 * them to this resolver.
 */
export const resolveOwnedApiKey = async (
  userId: string,
  keyId: string,
  adapters: ResolveOwnedApiKeyAdapters
): Promise<IUserApiKeyDocument | null> => {
  if (!userId) return null;

  const { db } = adapters;
  const visible = (key: IUserApiKeyDocument | null) => (key?.orgOwned && !adapters.includeOrgOwned ? null : key);

  const minted = await db.userApiKeys.findByUserIdAndId(userId, keyId);
  if (minted) return visible(minted);

  const administeredOrgIds = await db.organizations.findIdsAdministeredBy(userId);
  return visible(await db.userApiKeys.findByOrganizationIdsAndId(administeredOrgIds, keyId));
};
