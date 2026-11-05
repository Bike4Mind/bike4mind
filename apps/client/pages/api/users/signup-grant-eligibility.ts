import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { unlockSignupGrantFromActivity } from '@server/credits/activityUnlock';
import { retryOrgInviteBonus } from '@server/credits/orgInviteBonus';

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 5, windowMs: 60000 }))
  .post(async (req, res) => {
    let result: Awaited<ReturnType<typeof unlockSignupGrantFromActivity>>;
    try {
      result = await unlockSignupGrantFromActivity(req.user.id);
    } finally {
      // After the unlock, so a tranche this call just paid makes the bonus payable in the same call.
      await retryOrgInviteBonus(req.user.id).catch(() => {
        console.warn('[signup-grant] Organization invite bonus retry failed');
      });
    }
    res.json(result);
  });
