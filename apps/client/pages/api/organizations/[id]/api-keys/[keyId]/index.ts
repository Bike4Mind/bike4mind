// PATCH /api/organizations/:id/api-keys/:keyId
// Changes a live org-owned key's scopes and/or reach grants (IUserApiKey.orgOwned.grants) in place;
// the secret is unchanged. Owner, current manager or platform admin (`manageKeys`). Product scopes
// are judged on the org's entitlement, and every change is audited as org.api_key.access_updated.

import { OrgApiKeyGrantsSchema, type IOrgApiKeyView, type OrgApiKeyGrant } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertOrgApiKeyLive,
  assertOrgApiKeyScopesOffered,
  loadOrgOwnedKey,
  normalizeOrgApiKeyGrants,
  resolveCreatorNames,
  toOrgApiKeyView,
} from '@server/organizations/orgApiKeys';
import { endKeyRealtimeConnections } from '@server/utils/adminApiKeyActions';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';
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
    const org = await verifyOrgPermission(user, stringParam(req.query.id), 'manageKeys');
    const body = parseOrBadRequest(UpdateOrgApiKeyBodySchema, req.body);
    const { serviceAccount, apiKey } = await loadOrgOwnedKey(org.id, stringParam(req.query.keyId));
    assertOrgApiKeyLive(apiKey, 'changed');

    // Read, compare, write and audit under one transaction: a revoke that committed since the check
    // above is refused, and the audit's `before` is what the write actually replaced.
    const changed = await withTransaction(async () => {
      const { apiKey: current } = await loadOrgOwnedKey(org.id, apiKey.id);
      assertOrgApiKeyLive(current, 'changed');

      const previousScopes = current.scopes ?? [];
      // Plain copies: the stored grants are subdocuments, and the audit row must hold plain values.
      const previousGrants: OrgApiKeyGrant[] = (current.orgOwned?.grants ?? []).map(
        ({ resourceType, resourceId, permission }) => ({ resourceType, resourceId, permission })
      );
      const scopes = body.scopes ? [...new Set(body.scopes)] : previousScopes;
      // Only scopes being added are judged on the plan, so a scope the org has since lost does not
      // block an unrelated edit; the admin can still drop it.
      const addedScopes = scopes.filter(scope => !previousScopes.includes(scope));
      if (addedScopes.length > 0) await assertOrgApiKeyScopesOffered(org.id, addedScopes);
      const grants = body.grants ? await normalizeOrgApiKeyGrants(org.id, body.grants, previousGrants) : previousGrants;

      const scopesChanged = !sameSet(scopes, previousScopes);
      const grantsChanged = !sameSet(grantKeys(grants), grantKeys(previousGrants));
      if (!scopesChanged && !grantsChanged) return false;

      await userApiKeyRepository.update({
        id: current.id,
        scopes,
        orgOwned: { createdByUserId: current.orgOwned!.createdByUserId, grants },
      });
      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.access_updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `changed the access of organization API key "${current.name}"`,
        details: {
          keyId: current.id,
          keyPrefix: current.keyPrefix,
          ...(scopesChanged ? { scopes: { before: previousScopes, after: scopes } } : {}),
          ...(grantsChanged ? { grants: { before: previousGrants, after: grants } } : {}),
        },
      });
      return true;
    });
    // After commit: a live realtime connection was authorized under the old scopes and reach.
    if (changed) await endKeyRealtimeConnections(apiKey.id, req.logger);

    const updated = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, apiKey.id);
    if (!updated) throw new Error('Updated organization API key could not be read back');
    const view: IOrgApiKeyView = toOrgApiKeyView(updated, await resolveCreatorNames([updated]));
    return res.json(view);
  })
);

export default handler;
