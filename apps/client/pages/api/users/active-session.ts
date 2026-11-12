import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordHeartbeat } from '@server/credits/recordActiveSession';

export default baseApi({ auth: 'jwtOnly', recordsActivity: false })
  .use(csrfProtection())
  .use(rateLimit({ limit: 6, windowMs: 60000 }))
  .post(async (req, res) => res.json(await recordHeartbeat(req.user.id)));
