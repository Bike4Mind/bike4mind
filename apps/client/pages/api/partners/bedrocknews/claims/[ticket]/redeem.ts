import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { findPayableUser } from '@server/partners/bedrocknewsPuzzleReward';
import { warnIfOperatorFault } from '@server/partners/bedrocknewsClaimStates';
import { redeemTicket, type ClaimResult } from '@server/partners/bedrocknewsTickets';

type RedeemResponse =
  | { state: 'done'; result: ClaimResult }
  | { state: 'verify-email' }
  | { state: 'expired' }
  | { state: 'in-progress' }
  | { state: 'budget-spent' }
  | { state: 'not-found' }
  | { state: 'unavailable' };

const FAILURE_STATES: Record<string, RedeemResponse> = {
  B4M_NOT_ELIGIBLE: { state: 'verify-email' },
  TICKET_EXPIRED: { state: 'expired' },
  CLAIM_IN_PROGRESS: { state: 'in-progress' },
  B4M_BUDGET_SPENT: { state: 'budget-spent' },
  TICKET_NOT_FOUND: { state: 'not-found' },
};

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 10, windowMs: 60000 }))
  .post(async (req, res) => {
    const respond = (body: RedeemResponse) => res.json(body);

    const user = await findPayableUser(req.user.id);
    if (!user) return respond({ state: 'verify-email' });

    const redeemed = await redeemTicket(String(req.query.ticket), { id: req.user.id, email: user.email });
    if (redeemed.ok) return respond({ state: 'done', result: redeemed.result });

    warnIfOperatorFault('redeem', redeemed.code);
    return respond(FAILURE_STATES[redeemed.code] ?? { state: 'unavailable' });
  });
