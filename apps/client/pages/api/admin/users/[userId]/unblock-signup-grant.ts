import { heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { rerunDomainGrantAfterUnblock } from '@server/credits/rerunDomainGrantAfterUnblock';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userId, reason, target } = await readSignupGrantAdminAction(req, 'user.credits.grant_unblocked', {
      guardTargetVerb: 'unblock signup credit grants for',
    });
    const result = await userService.unblockSignupGrant(userId, {
      users: userRepository,
      heldRewards: heldCreditRewardRepository,
      audit: async () => {
        await recordAdminActionFromRequest(req, {
          action: 'user.credits.grant_unblocked',
          target,
          summary: 'resumed signup grants and rewards',
          reason,
        });
      },
    });
    if (result.outcome === 'applied') await rerunDomainGrantAfterUnblock(userId, req.logger);
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
