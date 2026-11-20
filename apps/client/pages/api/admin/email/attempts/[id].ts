import { emailSendAttemptRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
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
