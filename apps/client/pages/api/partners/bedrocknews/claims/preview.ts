import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { payableRungCredits, rungCredits } from '@server/partners/bedrocknewsPuzzleReward';
import { answerClaim, withOwnBalance } from '@server/partners/bedrocknewsClaimRoute';
import {
  failureState,
  isTicketPreview,
  malformedState,
  type PreviewState,
} from '@server/partners/bedrocknewsClaimStates';
import { previewTicket, type ClaimResult } from '@server/partners/bedrocknewsTickets';

const NOTHING_PAID: ClaimResult = { claimed: [], total: 0, balance: null, firstSolveCredits: 0, capped: 0 };

export default baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(rateLimit({ limit: 30, windowMs: 60000 }))
  .post((req, res) =>
    answerClaim(req, res, async (ticket, user): Promise<PreviewState> => {
      const preview = await previewTicket(ticket);
      if (!preview.ok) return failureState('preview', preview.code);
      if (!isTicketPreview(preview.preview)) return malformedState('preview');

      const { status, rungs, result, b4mUserId } = preview.preview;
      if (status === 'expired') return { state: 'expired' };
      // Another redeem holds the ticket; offering it as ready would invite a second confirm.
      if (status === 'redeeming') return { state: 'in-progress' };
      if (status === 'redeemed') {
        if (!result) return { state: 'unavailable' };
        // Another account's payout would read as this user's own.
        if (b4mUserId !== user.id) return { state: 'claimed-elsewhere' };
        return { state: 'redeemed', result: await withOwnBalance(result, user.id) };
      }

      // Everything was paid through another ticket; show it as claimed rather than "Add 0 credits".
      if (rungs.length === 0) return { state: 'redeemed', result: NOTHING_PAID };

      const [credits, payable] = await Promise.all([
        rungCredits(rungs.map(({ length, hard }) => ({ tier: length, hard }))),
        payableRungCredits(
          user.id,
          rungs.map(({ date, length, hard }) => ({ puzzleDate: date, tier: length, hard }))
        ),
      ]);
      return { state: 'ready', credits, payable, rungs, account: user.email };
    })
  );
