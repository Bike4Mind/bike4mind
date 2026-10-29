import { SupportAccess } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { customerSupportAccess } from '@server/auth/impersonation';

const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const rows = await SupportAccess.find({ userId: req.user.id })
    .select('sid startedAt expiresAt endedAt')
    .sort({ startedAt: -1 })
    .limit(50)
    .maxTimeMS(5000);
  return res.json({ items: rows.map(row => customerSupportAccess(row)) });
});
export default handler;
