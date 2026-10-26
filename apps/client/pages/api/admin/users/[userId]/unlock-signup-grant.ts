import { ApiKeyScope } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .post(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    const userId = req.query.userId;
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
    const reason = parseAdminActionReason(req.body?.reason);
    const actorId = req.user.id;
    const result = await userService.unlockSignupGrant(userId, 'admin', {
      db: {
        users: userRepository,
        adminSettings: adminSettingsRepository,
        creditTransactions: creditTransactionRepository,
        creditLots: creditLotRepository,
      },
      reason,
      validators: { admin: async () => (await userRepository.findById(actorId))?.isAdmin === true },
      audit: async ({ credits, creditTransactionId }) => {
        await recordAdminActionFromRequest(req, {
          action: 'user.credits.adjusted',
          target: { kind: 'user', id: userId, displayName: userId },
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
