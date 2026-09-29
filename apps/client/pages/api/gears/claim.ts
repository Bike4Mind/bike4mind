import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { z } from 'zod';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { creditTransactionRepository, gearStampRepository, userRepository } from '@bike4mind/database';
import { GEAR_DEFAULTS, evaluateGears, gearTxId, type GearKey } from './status';

/**
 * POST /api/gears/claim - pay out one gear's reward, at the user's request.
 *
 * The client only names the gear. Whether it is claimable is decided here, by
 * the same evaluation GET /api/gears/status reports from, so a stale card or a
 * hand-made request cannot pay for a gear whose conditions are not met.
 *
 * Safe to repeat: the ledger's unique transactionId means a second claim, or a
 * concurrent one, never pays twice. It answers `alreadyClaimed` instead.
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
    if (!gear.rewardEligible) return res.status(409).json({ error: 'reward_pending' });
    if (gear.credits <= 0) return res.status(409).json({ error: 'no_reward' });

    const holder = await creditService.addCredits(
      {
        ownerId: String(userId),
        ownerType: CreditHolderType.User,
        credits: gear.credits,
        type: 'generic_add',
        transactionId: gearTxId(String(userId), key),
        reason: `gear unlock: ${key}`,
      },
      { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
    );
    if (!holder) return res.status(500).json({ error: 'Reward could not be paid' });

    // addCredits returns the holder on both a fresh grant and an idempotent
    // duplicate, so it cannot say which request paid. claimOnce is a race-safe
    // (userId, key) upsert: only the inserting request reports the payout, so two
    // quick clicks do not each announce it. The ledger stays the source of truth
    // for the money; this only de-dups the announcement.
    const won = await gearStampRepository.claimOnce(String(userId), `reward:${key}`);
    return won
      ? res.status(200).json({ key, creditsAwarded: gear.credits })
      : res.status(200).json({ key, alreadyClaimed: true });
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
