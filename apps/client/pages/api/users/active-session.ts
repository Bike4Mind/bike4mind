import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { recordHeartbeat } from '@server/credits/recordActiveSession';

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 6, windowMs: 60000 }))
  .post(async (req, res) => res.json(await recordHeartbeat(req.user.id)));
