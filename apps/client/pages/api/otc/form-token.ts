import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { OTC_LIMITS, ipSubject, otcCounterLimit } from '@server/utils/otcLimits';
import { signSignupFormToken } from '@server/utils/signupBotChecks';

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(otcCounterLimit({ bucket: 'form-token-ip', window: OTC_LIMITS.formToken.perIp, subject: ipSubject }))
  .get(async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ formToken: signSignupFormToken() });
  });

export default handler;
