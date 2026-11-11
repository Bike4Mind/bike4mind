// GET/POST /api/organizations/:id/api-keys
// The org's org-owned API keys: held by its service account, billed to the org, and unaffected by any
// member leaving (server/organizations/orgApiKeys.ts). Owner, current manager or platform admin
// (verifyOrgAccess). POST returns the key's secret once.

import { CreditHolderType, type IOrgApiKeySecretResponse, type IOrgApiKeyView } from '@bike4mind/common';
import { agentRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { isApiKeyScopeOffered, isKnownApiKeyScope } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { ForbiddenError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { resolveApiKeyScopeAccess } from '@server/entitlements/apiKeyScopeAccess';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  ORG_API_KEY_SCOPE_VALUES,
  findServiceAccount,
  getOrCreateServiceAccount,
  resolveCreatorNames,
  toOrgApiKeyView,
} from '@server/organizations/orgApiKeys';
import { assertApiKeyAccessAllowed } from '@server/utils/apiKeyAccessGate';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { z } from 'zod';

const CreateOrgApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.string())
    .min(1)
    .refine(scopes => scopes.every(scope => ORG_API_KEY_SCOPE_VALUES.includes(scope)), {
      message: 'Scope not allowed on an organization key',
    }),
  expiresAt: z.iso
    .datetime()
    .optional()
    .refine(value => value === undefined || new Date(value).getTime() > Date.now(), {
      message: 'expiresAt must be in the future',
    }),
});

const orgIdOf = (query: { id?: string }): string => (typeof query.id === 'string' ? query.id : '');

// Session only: a key must never be able to mint, list or replace the org's keys.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, IOrgApiKeyView[], unknown, { id?: string; includeDisabled?: string }>(async (req, res) => {
      const org = await verifyOrgAccess(req.user!, orgIdOf(req.query));
      const serviceAccount = await findServiceAccount(org.id);
      if (!serviceAccount) return res.json([]);

      const keys = await userApiKeyService.listUserApiKeys(
        serviceAccount.id,
        { db: { userApiKeys: userApiKeyRepository } },
        { includeDisabled: req.query.includeDisabled === 'true' }
      );
      const orgKeys = keys.filter(key => key.orgOwned && key.organizationId === org.id);
      const creatorNames = await resolveCreatorNames(orgKeys);
      return res.json(orgKeys.map(key => toOrgApiKeyView(key, creatorNames)));
    })
  )
  .post(
    asyncHandler<{}, IOrgApiKeySecretResponse, unknown, { id?: string }>(async (req, res) => {
      const user = req.user!;
      const org = await verifyOrgAccess(user, orgIdOf(req.query));
      const body = parseOrBadRequest(CreateOrgApiKeyBodySchema, req.body);

      // Product and contributed scopes still need the entitlement, judged on the admin creating the key.
      const scopeAccess = await resolveApiKeyScopeAccess(req);
      const unentitled = body.scopes.filter(scope => !isApiKeyScopeOffered(scope, scopeAccess));
      if (unentitled.length > 0) {
        throw new ForbiddenError(`Scope not available on your account: ${unentitled.join(', ')}`);
      }

      // The admin paid-only switch, judged on the org this key bills. apiKeyAuth re-runs it on every use.
      await assertApiKeyAccessAllowed(
        user,
        { billingOwnerType: CreditHolderType.Organization, organizationId: org.id },
        req
      );

      const serviceAccount = await getOrCreateServiceAccount(org);
      const created = await userApiKeyService.createUserApiKey(
        serviceAccount.id,
        {
          name: body.name,
          scopes: body.scopes,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
          metadata: { createdFrom: 'dashboard' },
          billingOwnerType: CreditHolderType.Organization,
          organizationId: org.id,
          orgOwned: { createdByUserId: user.id },
        },
        {
          db: { userApiKeys: userApiKeyRepository, agents: agentRepository },
          isKnownScope: isKnownApiKeyScope,
        }
      );

      await recordAdminActionFromRequest(req, {
        action: 'org.api_key.created',
        actorScope: 'organization',
        target: { kind: 'organization', id: org.id, displayName: org.name },
        summary: `created organization API key "${created.name}"`,
        details: { keyId: created.id, keyPrefix: created.keyPrefix, scopes: created.scopes },
      });

      const apiKey = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, created.id);
      if (!apiKey) throw new Error('Created organization API key could not be read back');
      const creatorNames = new Map([[user.id, user.name || user.username || user.id]]);
      return res.status(201).json({ apiKey: toOrgApiKeyView(apiKey, creatorNames), key: created.key });
    })
  );

export default handler;
