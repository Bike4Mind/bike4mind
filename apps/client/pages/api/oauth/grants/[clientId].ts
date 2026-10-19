import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { oauthGrantRepository, oauthRefreshTokenRepository } from '@bike4mind/database';
import { logAuthAudit } from '@server/utils/authAudit';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

/**
 * Revoke one OAuth client grant. The repository scopes the update to req.user.id,
 * so a clientId belonging to another account's grant is indistinguishable from an
 * unknown one (404 either way) and can never be revoked cross-account.
 */
const handler = baseApi({ auth: 'jwtOnly' }).delete(
  asyncHandler<{}, unknown, unknown, { clientId?: string }>(async (req, res) => {
    // An admin impersonating a user would act on the real customer's grants; refuse it.
    if (req.user.impersonatedBy) throw new ForbiddenError('Cannot manage OAuth grants while impersonating a user.');

    const userId = req.user.id;
    const clientId = req.query.clientId!;

    // A later re-consent clears the grant's revokedAt, so kill the refresh families now rather than
    // relying on the refresh-time grant check alone. Families go first: if this throws, the grant is
    // still live and a retry repeats both, whereas after the grant revoke a retry would 404 and skip it.
    await oauthRefreshTokenRepository.revokeAllForGrant(userId, clientId);
    const revoked = await oauthGrantRepository.revoke(userId, clientId);
    if (!revoked) throw new NotFoundError('OAuth grant not found');

    await logAuthAudit(req, { userId, event: 'oauth_grant_revoked', metadata: { clientId } });
    return res.status(200).json({ revoked: true, clientId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
