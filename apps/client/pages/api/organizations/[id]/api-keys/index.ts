// GET/POST /api/organizations/:id/api-keys
// The org's org-owned API keys: held by its service account, billed to the org, and unaffected by any
// member leaving (server/organizations/orgApiKeys.ts). Owner, current manager or platform admin
// (verifyOrgAccess). POST returns the key's secret once.

import { CreditHolderType, type IOrgApiKeySecretResponse, type IOrgApiKeyView } from '@bike4mind/common';
import { agentRepository, withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { isKnownApiKeyScope, isOrgApiKeyScope } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  creatorDisplayName,
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
    .refine(scopes => scopes.every(isOrgApiKeyScope), {
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
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const user = req.user!;
      const org = await verifyOrgAccess(user, orgIdOf(req.query));
      const body = parseOrBadRequest(CreateOrgApiKeyBodySchema, req.body);

      // The admin paid-only switch, judged on the org this key bills. apiKeyAuth re-runs it on every use.
      await assertApiKeyAccessAllowed(
        user,
        { billingOwnerType: CreditHolderType.Organization, organizationId: org.id },
        req
      );

      // Idempotent upsert, so it stays outside the transaction: a rolled-back mint leaves only the account.
      const serviceAccount = await getOrCreateServiceAccount(org);
      // The key and its strict audit row commit together, so a failed audit leaves no live key behind.
      const created = await withTransaction(async () => {
        const minted = await userApiKeyService.createUserApiKey(
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
          summary: `created organization API key "${minted.name}"`,
          details: { keyId: minted.id, keyPrefix: minted.keyPrefix, scopes: minted.scopes },
        });
        return minted;
      });

      const apiKey = await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, created.id);
      if (!apiKey) throw new Error('Created organization API key could not be read back');
      const creatorNames = new Map([[user.id, creatorDisplayName(user)]]);
      return res
        .status(201)
        .json({ apiKey: toOrgApiKeyView(apiKey, creatorNames), key: created.key } satisfies IOrgApiKeySecretResponse);
    })
  );

export default handler;
