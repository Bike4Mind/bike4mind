import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, type UserSignupCluster } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { findSignupCluster } from '@server/utils/userSignIns';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Other accounts that signed up with this user's signup fingerprint around the same time. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const cluster: UserSignupCluster = await findSignupCluster({
    id: user.id,
    createdAt: user.createdAt,
    signupMeta: user.signupMeta,
  });
  return res.json(cluster);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
