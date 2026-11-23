import { listHandoffDevicesContract } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { listHandoffDevices } from '@server/sessions/sessionHandoff';
import { sessionHandoffAdapters } from '@server/sessions/sessionHandoffAdapters';

export default nextRouteForContract(listHandoffDevicesContract, {
  recordsActivity: false,
  rateLimit: perUserRateLimit('GET /api/v1/handoff-devices'),
}).get(async (req, res) => {
  if (!req.user.sid) throw new UnauthorizedError('Sign in again to use device handoff.');
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ devices: await listHandoffDevices(req.user.id, sessionHandoffAdapters) });
});
export const config = { api: { externalResolver: true } };
