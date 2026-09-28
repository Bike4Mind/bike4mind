import { IOrganizationRepository, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

interface ResolveOwnedApiKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
}

/**
 * Single source for the "minter, or admin of the org the key is billed to"
 * resolution shared by revoke/rotate/updateEmbedKey and the [id] route's
 * branding-owner read. Returns the hydrated doc as-is (never serialized); writers
 * persist only the fields they change via db.userApiKeys.update({ id, ...patch }),
 * never the whole doc, so a concurrent revoke or spend $inc isn't reverted. The minter
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
  const minted = await db.userApiKeys.findByUserIdAndId(userId, keyId);
  if (minted) return minted;

  const administeredOrgIds = await db.organizations.findIdsAdministeredBy(userId);
  return db.userApiKeys.findByOrganizationIdsAndId(administeredOrgIds, keyId);
};
