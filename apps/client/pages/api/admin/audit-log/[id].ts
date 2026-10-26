import { canAccessAdmin } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));

  const { id } = req.query;
  if (typeof id !== 'string') throw new BadRequestError('Invalid audit entry id');

  const entry = await adminAuditLogRepository.findById(id);
  if (!entry) throw new NotFoundError('Audit entry not found');
  return res.json(entry);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
