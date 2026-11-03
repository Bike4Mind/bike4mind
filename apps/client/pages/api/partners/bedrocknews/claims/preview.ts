import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { currentBalance, findPayableUser, rungCredits } from '@server/partners/bedrocknewsPuzzleReward';
import {
  isTicketPreview,
  ticketFromBody,
  warnIfOperatorFault,
  warnMalformed,
} from '@server/partners/bedrocknewsClaimStates';
import { previewTicket, type ClaimResult, type TicketPreview } from '@server/partners/bedrocknewsTickets';

type PreviewResponse =
  | { state: 'ready'; credits: number; rungs: TicketPreview['rungs']; account: string }
  | { state: 'verify-email' }
  | { state: 'redeemed'; result: ClaimResult }
  | { state: 'expired' }
  | { state: 'not-found' }
  | { state: 'unavailable' };

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 30, windowMs: 60000 }))
  .post(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const respond = (body: PreviewResponse, status = 200) => res.status(status).json(body);

    const ticket = ticketFromBody(req.body);
    if (!ticket) return respond({ state: 'not-found' }, 400);

    const user = await findPayableUser(req.user.id);
    if (!user) return respond({ state: 'verify-email' });

    const preview = await previewTicket(ticket);
    if (!preview.ok) {
      warnIfOperatorFault('preview', preview.code);
      if (preview.code === 'TICKET_NOT_FOUND') return respond({ state: 'not-found' });
      if (preview.code === 'TICKET_EXPIRED') return respond({ state: 'expired' });
      return respond({ state: 'unavailable' });
    }
    if (!isTicketPreview(preview.preview)) {
      warnMalformed('preview');
      return respond({ state: 'unavailable' });
    }

    const { status, rungs, result } = preview.preview;
    if (status === 'expired') return respond({ state: 'expired' });
    if (status === 'redeemed') {
      if (!result) return respond({ state: 'unavailable' });
      return respond({ state: 'redeemed', result: { ...result, balance: await currentBalance(req.user.id) } });
    }

    const credits = await rungCredits(rungs.map(({ length, hard }) => ({ tier: length, hard })));
    return respond({ state: 'ready', credits, rungs, account: user.email });
  });
