import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { z } from 'zod';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { creditTransactionRepository, gearStampRepository, userRepository, withTransaction } from '@bike4mind/database';
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
 *
 * The ledger row and the balance are written in one transaction. addCredits commits
 * them as two writes, and a ledger row with no balance behind it would read as paid
 * here forever - every retry would answer alreadyClaimed and the reward would be lost.
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

    const transactionId = gearTxId(String(userId), key);
    let paid: boolean;
    try {
      paid = await withTransaction(async () => {
        // Read inside the transaction, before writing. A concurrent claim that committed
        // first shows up here on the retry, and this attempt stops without a write. Left to
        // addCredits, the insert would hit the duplicate key, which aborts the transaction,
        // and every retry would hit it again until the driver gave up.
        if (await creditTransactionRepository.findOne({ transactionId })) return false;
        await creditService.addCredits(
          {
            ownerId: String(userId),
            ownerType: CreditHolderType.User,
            credits: gear.credits,
            type: 'generic_add',
            transactionId,
            reason: `gear unlock: ${key}`,
          },
          { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
        );
        return true;
      });
    } catch (err) {
      // Anything that got this far rolled back whole, so nothing is recorded as paid and a
      // retry pays. The one exception worth answering is a claim that won in the meantime.
      const {
        evaluations: [after],
      } = await evaluateGears(String(userId), [key]);
      if (after?.alreadyRewarded) return res.status(200).json({ key, alreadyClaimed: true });
      throw err;
    }
    if (!paid) return res.status(200).json({ key, alreadyClaimed: true });

    // claimOnce is a race-safe (userId, key) upsert that de-dups the announcement; the
    // transaction above already decides which request paid.
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
