import {
  ApiKeyScope,
  EmbedBrandingSchema,
  EmbedOriginsSchema,
  IOrganizationRepository,
  IUserApiKeyRepository,
} from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const updateEmbedKeySchema = z.object({
  keyId: z.string(),
  // Every field optional: only the provided fields change. `allowedOrigins`
  // reuses the common schema (dedup + cap; each entry must be an
  // already-normalized exact https origin). Host-aware first-party rejection
  // lives at the route, which has the runtime host.
  agentId: z.string().min(1).optional(),
  allowedOrigins: EmbedOriginsSchema.optional(),
  branding: EmbedBrandingSchema.optional(),
});

export type UpdateEmbedKeyParameters = z.infer<typeof updateEmbedKeySchema>;

interface UpdateEmbedKeyAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
    organizations: Pick<IOrganizationRepository, 'findIdsAdministeredBy'>;
  };
}

export interface UpdateEmbedKeyResult {
  id: string;
  name: string;
  agentId?: string;
  allowedOrigins?: string[];
  branding?: {
    primaryColor?: string;
    logoUrl?: string;
    displayName?: string;
    hideBranding?: boolean;
  };
}

/**
 * Configure an existing embed key (epic #41 Phase E): rebind the agent, replace
 * the origin allow-list, or update the branding fields. Only keys carrying the
 * `embed:chat` scope can be configured - the embed fields are meaningless on any
 * other key (mirrors the create-side coherence invariant). Absent fields are
 * left untouched; `allowedOrigins: []` explicitly clears the allow-list.
 *
 * Resolvable by the key's minter OR by an admin of the org the key is billed to
 * (owner or manager), mirroring the org-admin-aware LIST route - so an org admin
 * can configure any key billed to an org they administer, not just keys they
 * minted. The org-admin lookup is lazy: the minter path pays no extra query.
 */
export const updateEmbedKey = async (
  userId: string,
  parameters: UpdateEmbedKeyParameters,
  adapters: UpdateEmbedKeyAdapters
): Promise<UpdateEmbedKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, updateEmbedKeySchema);

  let apiKey = await db.userApiKeys.findByUserIdAndId(userId, params.keyId);
  if (!apiKey) {
    const administeredOrgIds = await db.organizations.findIdsAdministeredBy(userId);
    apiKey = await db.userApiKeys.findByOrganizationIdsAndId(administeredOrgIds, params.keyId);
  }
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }
  if (!apiKey.scopes.includes(ApiKeyScope.EMBED_CHAT)) {
    throw new BadRequestError('Only embed:chat keys can be configured with embed settings');
  }

  // Agent-ownership/access enforcement (does the caller own/can reach this
  // agentId?) is deferred to the Phase C runtime endpoint (#571), where the
  // binding is first consumed - it is enforced there, not at bind time. The
  // admin UI only offers owned agents; the create path applies the same
  // deferral. Do not treat this rebind as an access boundary.
  if (params.agentId !== undefined) apiKey.agentId = params.agentId;
  if (params.allowedOrigins !== undefined) apiKey.allowedOrigins = params.allowedOrigins;
  if (params.branding !== undefined) apiKey.branding = params.branding;

  await db.userApiKeys.update(apiKey);

  return {
    id: apiKey.id,
    name: apiKey.name,
    agentId: apiKey.agentId,
    allowedOrigins: apiKey.allowedOrigins,
    branding: apiKey.branding,
  };
};
