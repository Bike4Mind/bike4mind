import { sendSessionHandoffContract } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { sendSessionHandoff } from '@server/sessions/sessionHandoff';
import { sessionHandoffAdapters } from '@server/sessions/sessionHandoffAdapters';

export default nextRouteForContract(sendSessionHandoffContract, {
  rateLimit: perUserRateLimit('POST /api/v1/session-handoffs'),
}).post(async (req, res) => {
  if (!req.user.sid) throw new UnauthorizedError('Sign in again to use device handoff.');
  await sendSessionHandoff(req.user.id, req.validated, sessionHandoffAdapters);
  return res.json({ status: 'sent' });
});
export const config = { api: { externalResolver: true } };
