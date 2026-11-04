import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { buildHeldGrantAdapters } from '@bike4mind/server-utils/credits/heldSignupGrantAdapters';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userId, reason, target } = await readSignupGrantAdminAction(req, 'user.credits.adjusted');
    const result = await userService.releaseHeldSignupGrant(userId, buildHeldGrantAdapters(req.logger));
    if (result.outcome === 'applied') {
      // The payout has committed, so a failed audit write is logged rather than failing a paid release.
      try {
        await recordAdminActionFromRequest(req, {
          action: 'user.credits.adjusted',
          target,
          summary: 'released held signup grant',
          reason,
          details: { credits: result.credits, source: 'held_grant_release' },
        });
      } catch (error) {
        req.logger.error(`Audit entry failed for released held grant of user ${userId}`, error);
      }
    }
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
