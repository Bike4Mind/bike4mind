import { canAccessAdmin } from '@bike4mind/common';
import { emailSendAttemptRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!canAccessAdmin(req.user)) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  const attempt = await emailSendAttemptRepository.findById(id);
  if (!attempt) {
    throw new NotFoundError('Email attempt not found');
  }

  return res.json(attempt);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
