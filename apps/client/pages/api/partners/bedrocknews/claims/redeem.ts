import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { answerClaim, withOwnBalance } from '@server/partners/bedrocknewsClaimRoute';
import { failureState, isClaimResult, malformedState, type RedeemState } from '@server/partners/bedrocknewsClaimStates';
import { redeemTicket } from '@server/partners/bedrocknewsTickets';

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 10, windowMs: 60000 }))
  .post((req, res) =>
    answerClaim(req, res, async (ticket, user): Promise<RedeemState> => {
      const redeemed = await redeemTicket(ticket, user);
      if (!redeemed.ok) return failureState('redeem', redeemed.code);
      if (!isClaimResult(redeemed.result)) return malformedState('redeem');
      return { state: 'done', result: await withOwnBalance(redeemed.result, user.id) };
    })
  );
