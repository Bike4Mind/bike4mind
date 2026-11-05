import { heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userId, reason, target } = await readSignupGrantAdminAction(req, 'user.credits.grant_blocked', {
      guardTargetVerb: 'block signup credit grants for',
    });
    const result = await userService.blockSignupGrant(userId, {
      users: userRepository,
      heldRewards: heldCreditRewardRepository,
      audit: async () => {
        await recordAdminActionFromRequest(req, {
          action: 'user.credits.grant_blocked',
          target,
          summary: 'blocked signup grants and rewards',
          reason,
        });
      },
    });
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
