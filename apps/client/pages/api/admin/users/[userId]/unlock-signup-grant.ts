import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { hasAdminPermission } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { signupProtection } from '@bike4mind/server-utils/auth/signupProtection';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    const { userId, reason, target } = await readSignupGrantAdminAction(req, 'user.credits.adjusted', {
      guardTargetVerb: 'release signup credits for',
    });
    const actorId = req.user.id;
    const result = await userService.releaseRemainingSignupGrant(userId, {
      db: {
        users: userRepository,
        signupProtection,
        adminSettings: adminSettingsRepository,
        creditTransactions: creditTransactionRepository,
        creditLots: creditLotRepository,
      },
      reason,
      validators: {
        admin: async () => hasAdminPermission(await userRepository.findById(actorId), 'credits:adjust'),
      },
      audit: async ({ credits, creditTransactionId }) => {
        await recordAdminActionFromRequest(req, {
          action: 'user.credits.adjusted',
          target,
          summary: 'released signup grant remainder',
          reason,
          details: { credits, source: 'signup_unlock' },
          related: creditTransactionId ? { creditTransactionId } : undefined,
        });
      },
    });
    return res.json(result);
  });

export default handler;
