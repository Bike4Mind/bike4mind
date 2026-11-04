/**
 * POST   /api/v1/push-tokens - register (upsert) a device push token for the calling session.
 * DELETE /api/v1/push-tokens - unregister one; an unknown token is a success.
 *
 * The token is bound to the caller's session id (`req.user.sid`), never a body field, so ending
 * that session prunes it (see AuthSessionRepository.revokeBySid). JWT only: API keys have no session.
 */

import { registerPushTokenContract, unregisterPushTokenContract } from '@bike4mind/common';
import { pushTokenRepository } from '@bike4mind/database';
import { UnauthorizedError } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const registerRoute = nextRouteForContract(registerPushTokenContract, {
  rateLimit: perUserRateLimit('POST /api/v1/push-tokens'),
}).post(async (req, res) => {
  const { sid } = req.user;
  // A token with no session could never be pruned on logout, so refuse rather than orphan it.
  if (!sid) throw new UnauthorizedError('This access token has no session; sign in again to register a push token.');

  await pushTokenRepository.upsert({ ...req.validated, userId: req.user.id, sid });
  return res.status(204).end();
});

const unregisterRoute = nextRouteForContract(unregisterPushTokenContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/push-tokens'),
}).delete(async (req, res) => {
  await pushTokenRepository.removeByToken(req.validated.token, { userId: req.user.id });
  return res.status(204).end();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ POST: registerRoute, DELETE: unregisterRoute });
