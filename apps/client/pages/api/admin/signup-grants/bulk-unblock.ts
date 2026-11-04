import { heldCreditRewardRepository, userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readBulkSignupGrantAction } from '@server/credits/bulkSignupGrantAdminAction';
import { signupGrantAuditTarget } from '@server/credits/signupGrantAdminAction';
import { rerunDomainGrantAfterUnblock } from '@server/credits/rerunDomainGrantAfterUnblock';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

// Each re-run is a handful of reads and an idempotent grant, so a small fan-out keeps 100 ids from running serially.
const RERUN_CONCURRENCY = 5;

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userIds, reason, dryRun, targets } = await readBulkSignupGrantAction(
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
            target: targets.get(userId) ?? signupGrantAuditTarget(userId),
            summary: 'unblocked signup grants and rewards',
            reason,
            details: { bulk: true },
          });
        },
      }
    );
    for (let i = 0; i < result.undoUserIds.length; i += RERUN_CONCURRENCY) {
      await Promise.all(
        result.undoUserIds
          .slice(i, i + RERUN_CONCURRENCY)
          .map(userId => rerunDomainGrantAfterUnblock(userId, req.logger))
      );
    }
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } } };
export default handler;
