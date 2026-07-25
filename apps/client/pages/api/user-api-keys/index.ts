import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { validateEmbedBranding, validateEmbedKeyOrigins } from '@server/services/publish';
import {
  embedKeyOwnerHasEntitlement,
  gateEmbedBrandingWrite,
  type EmbedKeyOwnerRef,
} from '@server/entitlements/embedKeyEntitlement';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY } from '@client/lib/entitlements/registry';
import { logEvent } from '@server/utils/analyticsLog';
import {
  ApiKeyScope,
  CreditHolderType,
  IEmbedBranding,
  IUserApiKey,
  IUserApiKeyDocument,
  UserApiKeyEvents,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';

interface CreateApiKeyRequest {
  name: string;
  scopes: string[];
  expiresAt?: string;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerDay: number;
  };
  /**
   * When set, mint an org-billed key: its AI usage debits this organization's
   * credit pool instead of the minter. Only allowed for org owners/managers
   * (and platform admins) - enforced below.
   */
  organizationId?: string;
  /** Embed key (epic #41): the agent to bind, its https origin allow-list, and optional branding. */
  agentId?: string;
  allowedOrigins?: string[];
  branding?: IEmbedBranding;
  /** Embed key: lifetime spend ceiling in credits. Validated by the service. */
  spendCap?: number;
}

/** Deduplicate keys by id, preserving first occurrence (newest-first order). */
function dedupeById(keys: IUserApiKeyDocument[]): IUserApiKeyDocument[] {
  const seen = new Set<string>();
  return keys.filter(key => (seen.has(key.id) ? false : (seen.add(key.id), true)));
}

/**
 * Cache key for a key's resolved billing owner. The same minter can own a
 * personal key (owner = self) and an org-billed key (owner = org.userId) that
 * resolve to different plans, so key on the owner tuple - never on `userId`.
 */
function ownerCacheKey(key: IUserApiKeyDocument): string {
  return `${key.billingOwnerType ?? CreditHolderType.User}:${key.organizationId ?? key.userId}`;
}

/**
 * Serialize a repo result before attaching a computed field. The finders return
 * hydrated Mongoose docs whose `toJSON` emits only schema paths, so assigning a
 * non-schema field to the doc (or spreading it) would drop it; serialize first.
 * Falls back to a shallow copy for lean/plain-object results (e.g. in tests).
 */
function serializeKey(key: IUserApiKeyDocument): IUserApiKey {
  const doc = key as IUserApiKeyDocument & { toJSON?: () => IUserApiKey };
  return typeof doc.toJSON === 'function' ? doc.toJSON() : { ...key };
}

const handler = baseApi()
  .get(async (req, res) => {
    const userId = req.user?.id;

    // Opt-in so the documented public API keeps its active-only default; the
    // management UIs pass it to render revoked keys as `Revoked` rows.
    const listOptions = { includeDisabled: req.query.includeDisabled === 'true' };

    // Personal keys (minted by this user) plus every key billed to an org this
    // user administers - so any org admin sees the org's keys, not just the minter.
    const [personalKeys, administeredOrgIds] = await Promise.all([
      userApiKeyService.listUserApiKeys(userId, { db: { userApiKeys: userApiKeyRepository } }, listOptions),
      organizationRepository.findIdsAdministeredBy(userId),
    ]);

    const orgKeyLists = await Promise.all(
      administeredOrgIds.map(orgId =>
        userApiKeyService.listOrganizationApiKeys(orgId, { db: { userApiKeys: userApiKeyRepository } }, listOptions)
      )
    );

    const keys = dedupeById([...personalKeys, ...orgKeyLists.flat()]);

    // Expose whether each embed key's billing OWNER holds the white-label plan,
    // so the Configure UI gates the hide-branding toggle on the owner (matching
    // the serve/write rule) instead of the viewer. Resolve once per distinct
    // owner - a list spanning many keys but few owners pays a handful of lookups.
    const embedKeys = keys.filter(key => key.scopes.includes(ApiKeyScope.EMBED_CHAT));
    const uniqueOwners = new Map<string, IUserApiKeyDocument>();
    for (const key of embedKeys) {
      const cacheKey = ownerCacheKey(key);
      if (!uniqueOwners.has(cacheKey)) uniqueOwners.set(cacheKey, key);
    }
    const ownerHasWhitelabel = new Map<string, boolean>();
    await Promise.all(
      [...uniqueOwners].map(async ([cacheKey, key]) => {
        ownerHasWhitelabel.set(cacheKey, await embedKeyOwnerHasEntitlement(key, EMBED_WHITELABEL_ENTITLEMENT_KEY));
      })
    );

    const payload = keys.map(key => {
      const json = serializeKey(key);
      return key.scopes.includes(ApiKeyScope.EMBED_CHAT)
        ? { ...json, ownerHasWhitelabel: ownerHasWhitelabel.get(ownerCacheKey(key)) ?? false }
        : json;
    });

    return res.json(payload);
  })
  .post(async (req: Request<{}, unknown, CreateApiKeyRequest>, res) => {
    const userId = req.user?.id;
    const { name, scopes, expiresAt, rateLimit, organizationId, agentId, allowedOrigins, branding, spendCap } =
      req.body;

    // Authorize org-billed minting: caller must administer the org (owner or
    // manager) or be a platform admin. Fail closed on anything else.
    if (organizationId) {
      const administeredOrgIds = await organizationRepository.findIdsAdministeredBy(userId);
      const mayBillOrg = req.user?.isAdmin || administeredOrgIds.includes(organizationId);
      if (!mayBillOrg) {
        throw new ForbiddenError('You do not have permission to mint API keys billed to this organization');
      }
    }

    // Embed keys: apply the host-aware origin screen here (needs the runtime app
    // host). The service re-validates format/dedup/cap and enforces the agentId
    // binding. Pass the normalized list downstream.
    const isEmbedKey = Array.isArray(scopes) && scopes.includes(ApiKeyScope.EMBED_CHAT);
    const hasEmbedFields =
      agentId !== undefined || allowedOrigins !== undefined || branding !== undefined || spendCap !== undefined;
    let embedOrigins = allowedOrigins;
    if (isEmbedKey) {
      const originsCheck = validateEmbedKeyOrigins(allowedOrigins);
      if (!originsCheck.ok) {
        throw new BadRequestError(originsCheck.error);
      }
      embedOrigins = originsCheck.value;
    }
    // Branding format screen (hex color, https logo, caps); the service
    // re-validates with the same shared schema. The whitelabel write gate then
    // neutralizes an unentitled hideBranding elevation against the new key's
    // billing owner (same rule as the authoritative read gate) - so an admin
    // minting an org-billed key cannot persist a `true` the org's plan does not
    // earn.
    const brandingCheck = validateEmbedBranding(branding);
    if (!brandingCheck.ok) {
      throw new BadRequestError(brandingCheck.error);
    }
    const brandingOwner: EmbedKeyOwnerRef = organizationId
      ? { userId, billingOwnerType: CreditHolderType.Organization, organizationId }
      : { userId, billingOwnerType: CreditHolderType.User };
    const screenedBranding = await gateEmbedBrandingWrite(brandingOwner, brandingCheck.value);

    const newApiKey = await userApiKeyService.createUserApiKey(
      userId,
      {
        name,
        scopes: scopes as any, // Type conversion handled in service
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        rateLimit,
        metadata: {
          clientIP: req.ip,
          userAgent: req.headers['user-agent'],
          createdFrom: 'dashboard' as const,
        },
        // Forward embed fields whenever present - not only for embed keys - so the
        // service's coherence invariant rejects a non-embed key that carries them
        // (fail loud) instead of silently dropping them.
        ...(isEmbedKey || hasEmbedFields
          ? { agentId, allowedOrigins: embedOrigins, branding: screenedBranding, spendCap }
          : {}),
        ...(organizationId
          ? { organizationId, billingOwnerType: CreditHolderType.Organization }
          : { billingOwnerType: CreditHolderType.User }),
      },
      {
        db: {
          userApiKeys: userApiKeyRepository,
        },
      }
    );

    await logEvent(
      {
        userId,
        type: UserApiKeyEvents.CREATED,
        metadata: {
          keyId: newApiKey.id,
          name: newApiKey.name,
          scopes: newApiKey.scopes,
          expiresAt: newApiKey.expiresAt?.toISOString(),
          createdFrom: 'dashboard',
          billingOwnerType: newApiKey.billingOwnerType,
          organizationId: newApiKey.organizationId,
        },
      },
      { ability: req.ability }
    );

    return res.status(201).json(newApiKey);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
