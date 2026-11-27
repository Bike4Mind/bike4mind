import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { passkeyCredentialRepository, userRepository } from '@bike4mind/database';
import { logAuthAudit } from '@server/utils/authAudit';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { stepUpGate } from '@server/auth/stepUp';

const LAST_FACTOR_REFUSAL = {
  error: 'This passkey is your only second factor. Add another one, or turn off two-step verification instead.',
  code: 'last_factor',
};

/**
 * Remove one passkey. The repository scopes the delete to req.user.id, so another account's
 * id is indistinguishable from an unknown one (404 either way). A passkey-only user's last
 * passkey is their only factor, so removing it is refused: turning MFA off goes through
 * /api/auth/mfa/disable, which owns the enforcement check and the session/trust teardown.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(stepUpGate())
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.user.id;
      const passkeyId = req.query.id!;

      const user = await userRepository.findById(userId);
      if (!user) throw new NotFoundError('User not found');

      if (user.mfa?.passkeyEnabled && !user.mfa.totpEnabled) {
        // The up-front count answers the common case without touching the credential;
        // removeUnlessLast is what holds the invariant against a concurrent removal.
        if ((await passkeyCredentialRepository.countByUser(userId)) <= 1) {
          return res.status(409).json(LAST_FACTOR_REFUSAL);
        }
        const outcome = await passkeyCredentialRepository.removeUnlessLast(passkeyId, userId);
        if (outcome === 'not_found') throw new NotFoundError('Passkey not found');
        if (outcome === 'last') return res.status(409).json(LAST_FACTOR_REFUSAL);
      } else {
        const removed = await passkeyCredentialRepository.remove(passkeyId, userId);
        if (!removed) throw new NotFoundError('Passkey not found');
        // Counted after the delete so two concurrent removals of the last two cannot both leave the flag on.
        if (user.mfa?.passkeyEnabled && (await passkeyCredentialRepository.countByUser(userId)) === 0) {
          await userRepository.update({ id: userId, 'mfa.passkeyEnabled': false, updatedAt: new Date() });
        }
      }

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
