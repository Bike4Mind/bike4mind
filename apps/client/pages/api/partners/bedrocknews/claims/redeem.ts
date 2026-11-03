import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { currentBalance, findPayableUser } from '@server/partners/bedrocknewsPuzzleReward';
import {
  isClaimResult,
  ticketFromBody,
  warnIfOperatorFault,
  warnMalformed,
} from '@server/partners/bedrocknewsClaimStates';
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
    res.setHeader('Cache-Control', 'no-store');
    const respond = (body: RedeemResponse, status = 200) => res.status(status).json(body);

    const ticket = ticketFromBody(req.body);
    if (!ticket) return respond({ state: 'not-found' }, 400);

    const user = await findPayableUser(req.user.id);
    if (!user) return respond({ state: 'verify-email' });

    const redeemed = await redeemTicket(ticket, { id: req.user.id, email: user.email });
    if (!redeemed.ok) {
      warnIfOperatorFault('redeem', redeemed.code);
      return respond(FAILURE_STATES[redeemed.code] ?? { state: 'unavailable' });
    }
    if (!isClaimResult(redeemed.result)) {
      warnMalformed('redeem');
      return respond({ state: 'unavailable' });
    }
    return respond({
      state: 'done',
      result: { ...redeemed.result, balance: await currentBalance(req.user.id) },
    });
  });
