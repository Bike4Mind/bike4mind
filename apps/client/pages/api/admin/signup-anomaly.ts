import { baseApi } from '@server/middlewares/baseApi';
import { getSignupAnomalySnapshot } from '@server/users/signupAnomaly';

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ message: 'Admin access required' });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await getSignupAnomalySnapshot());
});

export const config = { api: { externalResolver: true } };
