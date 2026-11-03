import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, type UserLinkedAccount } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { findLinkedAccounts } from '@server/billing/linkedAccounts';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Accounts sharing this user's card, or only a signup or payment IP. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const linked: UserLinkedAccount[] = (await findLinkedAccounts(user)).map(
    ({ id, name, email, strength, via, blocked }) => ({ id, name, email, strength, via, blocked })
  );
  return res.json(linked);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
