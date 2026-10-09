import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { passkeyCredentialRepository } from '@bike4mind/database';
import { logAuthAudit } from '@server/utils/authAudit';
import { NotFoundError } from '@server/utils/errors';

/**
 * Remove one passkey. The repository scopes the delete to req.user.id, so another account's
 * id is indistinguishable from an unknown one (404 either way).
 */
const handler = baseApi({ auth: 'jwtOnly' }).delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user.id;
    const passkeyId = req.query.id!;

    const removed = await passkeyCredentialRepository.remove(passkeyId, userId);
    if (!removed) throw new NotFoundError('Passkey not found');

    await logAuthAudit(req, { userId, event: 'passkey_removed', metadata: { passkeyId, scope: 'one' } });
    return res.status(200).json({ removed: true, id: passkeyId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
