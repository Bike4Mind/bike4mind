import { baseApi } from '@server/middlewares/baseApi';
import { userApiKeyRepository } from '@bike4mind/database';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import { createServiceKey } from '@server/organizations/serviceAccounts';
import { z } from 'zod';

const orgId = z.string().regex(/^[a-f\d]{24}$/i);
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] })
  .get(async (req, res) => {
    const organizationId = orgId.parse(req.query.id);
    await verifyOrgAccess(req.user, organizationId);
    const keys = (await userApiKeyRepository.findByOrganizationId(organizationId)).filter(key => key.orgOwned);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(
      keys.map(key => ({
        id: key.id,
        name: key.name,
        principalId: key.userId,
        keyPrefix: key.keyPrefix,
        scopes: key.scopes,
        status: key.status,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        revokedAt: key.revokedAt,
        createdByUserId: key.orgOwned?.createdByUserId,
        grants: key.orgOwned?.grants ?? [],
      }))
    );
  })
  .post(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(201).json(await createServiceKey(req.user, orgId.parse(req.query.id), req.body));
  });

export const config = { api: { externalResolver: true } };
export default handler;
