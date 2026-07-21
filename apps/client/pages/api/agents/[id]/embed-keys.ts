import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { agentRepository, organizationRepository } from '@bike4mind/database';
import { ApiKeyStatus } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

/**
 * GET /api/agents/[id]/embed-keys - the embed keys bound to an agent, for the
 * snippet generator. Read-only metadata: raw key secrets are shown once at
 * mint time and are not recoverable (only a hash is stored), so this returns
 * name/prefix/origins for selection - never key material. Minting/revoking is
 * the embed admin flow, not this route.
 */

/** Slim projection: the full doc carries usage/metadata (client IPs) that the
 *  snippet UI has no business seeing. */
export interface EmbedKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;
  agentId: string;
  allowedOrigins: string[];
  status: ApiKeyStatus;
  createdAt: Date;
}

const handler = baseApi().get(async (req, res) => {
  const { id } = req.query;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BadRequestError('agentId is required');
  }

  const callerId = req.user!.id;
  const [agent, administeredOrgIds] = await Promise.all([
    agentRepository.findById(id),
    organizationRepository.findIdsAdministeredBy(callerId),
  ]);
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }

  // Positive allow-list: each grant requires its field SET and matching, so a
  // both-unset row can never pass. 404 (not 403) so a non-owner cannot tell a
  // forbidden agent from a nonexistent one.
  const ownsAgent = !!agent.userId && agent.userId === callerId;
  const adminsAgentOrg = !!agent.organizationId && administeredOrgIds.includes(agent.organizationId);
  if (!ownsAgent && !adminsAgentOrg && !req.user!.isAdmin) {
    throw new NotFoundError('Agent not found');
  }

  const keys = await userApiKeyService.listAgentEmbedKeys(id, { db: { userApiKeys: userApiKeyRepository } });

  // Defense in depth on top of the agent gate: only keys the caller could see
  // on their own key surfaces (minted by them, or billed to an org they admin).
  const adminOrgSet = new Set(administeredOrgIds);
  const visible = req.user!.isAdmin
    ? keys
    : keys.filter(
        key =>
          (!!key.userId && key.userId === callerId) || (!!key.organizationId && adminOrgSet.has(key.organizationId))
      );

  const items: EmbedKeyListItem[] = visible.map(key => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    agentId: key.agentId!,
    allowedOrigins: key.allowedOrigins ?? [],
    status: key.status,
    createdAt: key.createdAt,
  }));

  return res.json(items);
});

export const config = { api: { externalResolver: true } };
export default handler;
