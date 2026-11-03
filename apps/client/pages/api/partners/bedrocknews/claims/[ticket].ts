import { baseApi } from '@server/middlewares/baseApi';
import { findPayableUser, rungCredits } from '@server/partners/bedrocknewsPuzzleReward';
import { warnIfOperatorFault } from '@server/partners/bedrocknewsClaimStates';
import { previewTicket, type ClaimResult, type TicketPreview } from '@server/partners/bedrocknewsTickets';

type PreviewResponse =
  | { state: 'ready'; credits: number; rungs: TicketPreview['rungs']; account: string }
  | { state: 'verify-email' }
  | { state: 'redeemed'; result: ClaimResult }
  | { state: 'expired' }
  | { state: 'not-found' }
  | { state: 'unavailable' };

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const ticket = String(req.query.ticket);
  const respond = (body: PreviewResponse) => res.json(body);

  const user = await findPayableUser(req.user.id);
  if (!user) return respond({ state: 'verify-email' });

  const preview = await previewTicket(ticket);
  if (!preview.ok) {
    warnIfOperatorFault('preview', preview.code);
    if (preview.code === 'TICKET_NOT_FOUND') return respond({ state: 'not-found' });
    if (preview.code === 'TICKET_EXPIRED') return respond({ state: 'expired' });
    return respond({ state: 'unavailable' });
  }

  const { status, rungs, result } = preview.preview;
  if (status === 'expired') return respond({ state: 'expired' });
  if (status === 'redeemed') return respond(result ? { state: 'redeemed', result } : { state: 'unavailable' });

  const credits = await rungCredits(rungs.map(({ length, hard }) => ({ tier: length, hard })));
  return respond({ state: 'ready', credits, rungs, account: user.email });
});
