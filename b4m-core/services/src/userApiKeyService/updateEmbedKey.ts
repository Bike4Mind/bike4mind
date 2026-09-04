import {
  ApiKeyScope,
  EmbedBrandingSchema,
  EmbedOriginsSchema,
  IAgentRepository,
  IOrganizationRepository,
  isAgentOwnedByEmbedKey,
  IUserApiKeyRepository,
} from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';
import { resolveOwnedApiKey } from './resolveOwnedApiKey';

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
    /** Required so a rebind can verify the agent it points at. See createUserApiKey. */
    agents: Pick<IAgentRepository, 'findById'>;
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
 * Scoped by resolveOwnedApiKey (the key's minter, or an admin of the org it is
 * billed to), so an org admin can configure any key billed to an org they
 * administer, not just keys they minted. The [id] route resolves the branding
 * owner through that same function, which is what keeps its white-label gate
 * from ever being narrower than this write.
 */
export const updateEmbedKey = async (
  userId: string,
  parameters: UpdateEmbedKeyParameters,
  adapters: UpdateEmbedKeyAdapters
): Promise<UpdateEmbedKeyResult> => {
  const { db } = adapters;
  const params = secureParameters(parameters, updateEmbedKeySchema);

  const apiKey = await resolveOwnedApiKey(userId, params.keyId, { db });
  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }
  if (!apiKey.scopes.includes(ApiKeyScope.EMBED_CHAT)) {
    throw new BadRequestError('Only embed:chat keys can be configured with embed settings');
  }

  // Agent-ownership IS enforced at bind time: the agent must belong to the org the
  // key bills or to its owner. This used to be deferred to the runtime consumer,
  // which left a key rebindable to another tenant's agent. The runtime checks stay
  // (a bound agent can change hands afterwards) but this is now an access boundary.
  if (params.agentId !== undefined) {
    const agent = await db.agents.findById(params.agentId);
    if (!agent || !isAgentOwnedByEmbedKey(agent, apiKey)) {
      throw new BadRequestError('agentId must reference an agent owned by the billing organization or the key owner');
    }
    apiKey.agentId = params.agentId;
  }
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
