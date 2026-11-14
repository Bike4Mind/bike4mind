/**
 * GET /api/models - the full internal `ModelInfo` list the SPA and CLI read.
 *
 * Unversioned and unpublished; integrators get the public projection at GET /api/v1/models
 * (pages/api/v1/models.ts). Both read getCallerModelList, so they list the same models;
 * v1 additionally drops disabled ones. Only this route serves `lockedModels` (see ModelInfo.access).
 */

import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveActiveOrg } from '@bike4mind/server-utils/utils/resolveActiveOrg';
import { apiKeyBillingOrgId } from '@server/billing/apiKeyBillingOrg';
import { getCallerModelList } from '@server/utils/callerModelList';

const handler = baseApi({
  requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE, ApiKeyScope.ME_READ, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
}).get(async (req, res) => {
  // The SPA sends its active org; an org-billed key always lists under its own org.
  const requestedOrgId = typeof req.query.organizationId === 'string' ? req.query.organizationId : undefined;
  const organizationId = apiKeyBillingOrgId(req.apiKeyInfo) ?? (await resolveActiveOrg(req, requestedOrgId));
  const payload = await getCallerModelList(req.user ?? null, req.logger, { organizationId });
  return res.status(200).json(payload);
});

export default handler;
