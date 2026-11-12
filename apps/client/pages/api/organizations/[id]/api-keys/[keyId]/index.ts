// PATCH /api/organizations/:id/api-keys/:keyId
// Changes an active org-owned key's scopes and/or reach grants (IUserApiKey.orgOwned.grants) in place;
// the secret is unchanged. Owner, current manager or platform admin (verifyOrgAccess). Product scopes
// are judged on the org's entitlement, and every change is audited as org.api_key.access_updated.

import { ApiKeyStatus, OrgApiKeyGrantsSchema, type IOrgApiKeyView, type OrgApiKeyGrant } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertOrgApiKeyScopesOffered,
  loadOrgOwnedKey,
  normalizeOrgApiKeyGrants,
  resolveCreatorNames,
  toOrgApiKeyView,
} from '@server/organizations/orgApiKeys';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { z } from 'zod';

const UpdateOrgApiKeyBodySchema = z
  .object({
    scopes: z.array(z.string()).min(1).optional(),
    grants: OrgApiKeyGrantsSchema.optional(),
  })
  .refine(body => body.scopes !== undefined || body.grants !== undefined, {
    message: 'Provide scopes or grants',
  });

const stringParam = (value: unknown): string => (typeof value === 'string' ? value : '');

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every(value => right.includes(value));

const grantKeys = (grants: readonly { resourceType: string; resourceId: string }[]): string[] =>
  grants.map(grant => `${grant.resourceType}:${grant.resourceId}`);

const handler = baseApi({ auth: 'jwtOnly' }).patch(
  asyncHandler<{}, unknown, unknown, { id?: string; keyId?: string }>(async (req, res) => {
    const user = req.user!;
    const org = await verifyOrgAccess(user, stringParam(req.query.id));
    const body = parseOrBadRequest(UpdateOrgApiKeyBodySchema, req.body);
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));
    if (apiKey.status !== ApiKeyStatus.ACTIVE) throw new BadRequestError('Only an active key can be changed');

    const previousScopes = apiKey.scopes ?? [];
    // Plain copies: the stored grants are subdocuments, and the audit row must hold plain values.
    const previousGrants: OrgApiKeyGrant[] = (apiKey.orgOwned?.grants ?? []).map(
      ({ resourceType, resourceId, permission }) => ({ resourceType, resourceId, permission })
    );
    const scopes = body.scopes ?? previousScopes;
    if (body.scopes) await assertOrgApiKeyScopesOffered(org.id, body.scopes);
    const grants = body.grants ? await normalizeOrgApiKeyGrants(org.id, body.grants) : previousGrants;

    const scopesChanged = !sameSet(scopes, previousScopes);
    const grantsChanged = !sameSet(grantKeys(grants), grantKeys(previousGrants));

    if (scopesChanged || grantsChanged) {
      // The change and its strict audit row commit together, so an unaudited change never lands.
      await withTransaction(async () => {
        await userApiKeyRepository.update({
          id: apiKey.id,
          scopes,
          orgOwned: { createdByUserId: apiKey.orgOwned!.createdByUserId, grants },
        });
        await recordAdminActionFromRequest(req, {
          action: 'org.api_key.access_updated',
          actorScope: 'organization',
          target: { kind: 'organization', id: org.id, displayName: org.name },
          summary: `changed the access of organization API key "${apiKey.name}"`,
          details: {
            keyId: apiKey.id,
            keyPrefix: apiKey.keyPrefix,
            ...(scopesChanged ? { scopes: { before: previousScopes, after: scopes } } : {}),
            ...(grantsChanged ? { grants: { before: previousGrants, after: grants } } : {}),
          },
        });
      });
      // A live realtime connection was authorized under the old scopes.
      if (scopesChanged) await endKeyRealtimeConnections(apiKey.id, req.logger);
    }

    const updated = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, apiKey.id);
    if (!updated) throw new Error('Updated organization API key could not be read back');
    const view: IOrgApiKeyView = toOrgApiKeyView(updated, await resolveCreatorNames([updated]));
    return res.json(view);
  })
);

export default handler;
