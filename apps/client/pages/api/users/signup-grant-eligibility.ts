import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { checkSignupGrantEligibility } from '@server/credits/signupGrantEligibility';

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 5, windowMs: 60000 }))
  .post(async (req, res) => res.json(await checkSignupGrantEligibility(req.user.id)));
