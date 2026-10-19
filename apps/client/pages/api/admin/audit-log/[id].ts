import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ensurePlatformAdmin } from '@server/utils/adminAuditQuery';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensurePlatformAdmin(req.user);

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
