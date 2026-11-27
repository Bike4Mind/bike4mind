import { oauthClientRepository, oauthClientSignInRepository, userRepository } from '@bike4mind/database';
import { ApiKeyScope, MODERATION_PAGE_READ, hasAdminPermission, type AdminUserOAuthApps } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The OAuth client a user signed up through and the apps they have signed in to, newest sign-in first. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
}).get(async (req, res) => {
  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const rows = await oauthClientSignInRepository.listByUser(user.id);
  const signupClientId = user.signupClientId ?? null;
  // The route admits moderators; client names are the OAuth clients list's data, so they need its permission.
  const canSeeNames = hasAdminPermission(req.user, 'support:read');
  const clients = canSeeNames
    ? await oauthClientRepository.findByClientIds([
        ...new Set([...(signupClientId ? [signupClientId] : []), ...rows.map(row => row.clientId)]),
      ])
    : new Map<string, { name: string }>();
  const nameOf = (clientId: string) => clients.get(clientId)?.name ?? null;

  const body: AdminUserOAuthApps = {
    signupClient: signupClientId ? { clientId: signupClientId, name: nameOf(signupClientId) } : null,
    apps: rows.map(row => ({
      clientId: row.clientId,
      name: nameOf(row.clientId),
      firstSignInAt: row.firstSignInAt.toISOString(),
      lastSignInAt: row.lastSignInAt.toISOString(),
    })),
  };
  return res.json(body);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
