import { emailSendAttemptRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
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
