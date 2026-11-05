import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { stepUpGate } from '@server/auth/stepUp';
import { userRepository } from '@bike4mind/database';
import { cancelAccountDeletion, findOwnedOrganizations, requestAccountDeletion } from '@server/users/accountDeletion';

/**
 * Self-serve account deletion. GET reads the pending deletion and the organizations blocking a
 * request; POST schedules it (step-up required); DELETE cancels it. GET and DELETE stay reachable
 * while the account is frozen (see deletionPendingGate in @bike4mind/server-utils).
 */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST', 'DELETE'] })
  .use(csrfProtection())
  .use(stepUpGate({ skip: req => req.method !== 'POST' }))
  .get(
    asyncHandler(async (req, res) => {
      const user = await userRepository.findById(req.user.id);
      const ownedOrganizations = await findOwnedOrganizations(req.user.id);
      res.json({ deletion: user?.deletion ?? null, ownedOrganizations });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const { deletion, subscriptions } = await requestAccountDeletion(req);
      res.status(202).json({ deletion, canceledSubscriptions: subscriptions.canceled.length });
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      await cancelAccountDeletion(req);
      res.status(204).end();
    })
  );

export default handler;
