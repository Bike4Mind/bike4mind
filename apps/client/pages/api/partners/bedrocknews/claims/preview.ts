import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { rungCredits } from '@server/partners/bedrocknewsPuzzleReward';
import { answerClaim, withOwnBalance } from '@server/partners/bedrocknewsClaimRoute';
import {
  failureState,
  isTicketPreview,
  malformedState,
  type PreviewState,
} from '@server/partners/bedrocknewsClaimStates';
import { previewTicket } from '@server/partners/bedrocknewsTickets';

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 30, windowMs: 60000 }))
  .post((req, res) =>
    answerClaim(req, res, async (ticket, user): Promise<PreviewState> => {
      const preview = await previewTicket(ticket);
      if (!preview.ok) return failureState('preview', preview.code);
      if (!isTicketPreview(preview.preview)) return malformedState('preview');

      const { status, rungs, result } = preview.preview;
      if (status === 'expired') return { state: 'expired' };
      // Another redeem holds the ticket; offering it as ready would invite a second confirm.
      if (status === 'redeeming') return { state: 'in-progress' };
      if (status === 'redeemed') {
        return result ? { state: 'redeemed', result: await withOwnBalance(result, user.id) } : { state: 'unavailable' };
      }

      const credits = await rungCredits(rungs.map(({ length, hard }) => ({ tier: length, hard })));
      return { state: 'ready', credits, rungs, account: user.email };
    })
  );
