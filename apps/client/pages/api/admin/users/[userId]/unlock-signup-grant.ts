import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { ForbiddenError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { signupProtection } from '@bike4mind/server-utils/auth/signupProtection';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const { userId, reason, target } = await readSignupGrantAdminAction(req, 'user.credits.adjusted');
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
      validators: { admin: async () => (await userRepository.findById(actorId))?.isAdmin === true },
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
