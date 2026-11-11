import { adminApi } from '@server/middlewares/adminApi';
import { getSignupAnomalySnapshot } from '@bike4mind/server-utils/users/signupAnomaly';

export default adminApi({ adminPermissions: { GET: 'support:read' }, auth: 'jwtOnly' }).get(async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await getSignupAnomalySnapshot());
});

export const config = { api: { externalResolver: true } };
