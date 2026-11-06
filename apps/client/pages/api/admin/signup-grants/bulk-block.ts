import { heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readBulkSignupGrantAction } from '@server/credits/bulkSignupGrantAdminAction';
import { signupGrantAuditTarget } from '@server/credits/signupGrantAdminAction';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userIds, reason, dryRun, targets } = await readBulkSignupGrantAction(
      req,
      'user.credits.grant_blocked',
      'block signup credit grants for'
    );
    if (dryRun) {
      return res.json(
        await userService.previewSignupGrantAction({ action: 'block', userIds }, { users: userRepository })
      );
    }
    const result = await userService.bulkSetSignupGrantBlock(
      { action: 'block', userIds },
      {
        users: userRepository,
        heldRewards: heldCreditRewardRepository,
        logger: req.logger,
        auditFor: userId => async () => {
          await recordAdminActionFromRequest(req, {
            action: 'user.credits.grant_blocked',
            target: targets.get(userId) ?? signupGrantAuditTarget(userId),
            summary: 'blocked signup grants and rewards',
            reason,
            details: { bulk: true },
          });
        },
      }
    );
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } } };
export default handler;
