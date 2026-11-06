import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { z } from 'zod';
import { creditService, userService } from '@bike4mind/services';
import { withTransaction } from '@bike4mind/database';
import { buildCreditRewardAdapters } from '@server/credits/creditRewardAdapters';
import { GEAR_DEFAULTS, evaluateGears, gearTxId, type GearKey } from '@server/services/gears/catalog';

/**
 * POST /api/gears/claim - pay out one gear's reward, at the user's request.
 *
 * The client only names the gear. Whether it is claimable is decided here, by
 * the same evaluation GET /api/gears/status reports from, so a stale card or a
 * hand-made request cannot pay for a gear whose conditions are not met.
 *
 * Safe to repeat: the ledger's unique transactionId means a second claim, or a
 * concurrent one, never pays twice. It answers `alreadyClaimed` instead.
 *
 * Pays from the trickle pool via creditService.payCreditReward. A dry pool queues the
 * reward (202 `queued`) for the hourly release, and the queued row counts as claimed.
 *
 * The ledger row and the balance are written in one transaction: a ledger row with no
 * balance behind it would read as paid here forever and the reward would be lost.
 */
const BodySchema = z.object({
  key: z.enum(GEAR_DEFAULTS.map(g => g.key) as [GearKey, ...GearKey[]]),
});

// jwtOnly: claiming pays credits and is a click in the Gears UI, so there is no
// reason for an API key to reach it.
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const { key } = parsed.data;

    const {
      evaluations: [gear],
    } = await evaluateGears(String(userId), [key]);
    // Disabled in Manage Gears: the card is gone, so there is nothing to claim.
    if (!gear) return res.status(404).json({ error: 'Gear not found' });
    if (gear.alreadyRewarded) return res.status(200).json({ key, alreadyClaimed: true });
    if (!gear.unlocked) return res.status(409).json({ error: 'not_unlocked' });
    if (!gear.rewardEligible) return res.status(409).json({ error: 'reward_pending', reason: gear.pendingReason });
    if (gear.credits <= 0) return res.status(409).json({ error: 'no_reward' });

    const transactionId = gearTxId(String(userId), key);
    let result: creditService.PayCreditRewardOutcome;
    try {
      // The budget draw commits outside the transaction, so a rollback hands it back.
      result = await userService.refundBudgetOnFailure(() =>
        withTransaction(() =>
          creditService.payCreditReward(
            {
              transactionId,
              userId: String(userId),
              credits: gear.credits,
              source: 'gear',
              reason: `gear unlock: ${key}`,
              description: `Gear unlock reward: ${key}`,
            },
            // A duplicate insert has already aborted the transaction; throw out of it rather than retry.
            buildCreditRewardAdapters({ duplicateTransactionId: 'throw', inTransaction: true })
          )
        )
      );
    } catch (err) {
      // Anything that got this far rolled back whole, so nothing is recorded as paid and a
      // retry pays. The one exception worth answering is a claim that won in the meantime.
      const {
        evaluations: [after],
      } = await evaluateGears(String(userId), [key]);
      if (after?.alreadyRewarded) return res.status(200).json({ key, alreadyClaimed: true });
      throw err;
    }
    // Only the request that wrote the ledger row reports the payout, so two quick clicks do not each announce it.
    if (result.outcome === 'paid') return res.status(200).json({ key, creditsAwarded: gear.credits });
    if (result.outcome === 'queued') return res.status(202).json({ key, queued: true });
    if (result.outcome === 'blocked') return res.status(403).json({ error: 'account_blocked' });
    return res.status(200).json({ key, alreadyClaimed: true });
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
