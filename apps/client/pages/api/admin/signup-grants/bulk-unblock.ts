import { heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readBulkSignupGrantAction } from '@server/credits/bulkSignupGrantAdminAction';
import { signupGrantAuditTarget } from '@server/credits/signupGrantAdminAction';
import { rerunDomainGrantAfterUnblock } from '@server/credits/rerunDomainGrantAfterUnblock';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userIds, reason, dryRun } = await readBulkSignupGrantAction(
      req,
      'user.credits.grant_unblocked',
      'unblock signup credit grants for'
    );
    if (dryRun) {
      return res.json(
        await userService.previewSignupGrantAction({ action: 'unblock', userIds }, { users: userRepository })
      );
    }
    const result = await userService.bulkSetSignupGrantBlock(
      { action: 'unblock', userIds },
      {
        users: userRepository,
        heldRewards: heldCreditRewardRepository,
        logger: req.logger,
        auditFor: userId => async () => {
          await recordAdminActionFromRequest(req, {
            action: 'user.credits.grant_unblocked',
            target: signupGrantAuditTarget(userId),
            summary: 'unblocked signup grants and rewards',
            reason,
            details: { bulk: true },
          });
        },
      }
    );
    for (const userId of result.undoUserIds) await rerunDomainGrantAfterUnblock(userId, req.logger);
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } } };
export default handler;
