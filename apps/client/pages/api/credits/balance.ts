import { creditLotRepository } from '@bike4mind/database';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';

const EXPIRING_SOON_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const handler = baseApi().get(async (req, res) => {
  const { user } = req;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const lots = await creditLotRepository.findByOwner(user.id, CreditHolderType.User);
  const consumption = creditService.computeConsumption(lots, user.currentCredits);
  const assigned = creditService.assignConsumptionFIFO(lots, consumption);

  const now = Date.now();
  const expiringSoon = assigned
    .filter(
      ({ lot, remaining }) =>
        remaining > 0 && lot.expiresAt.getTime() > now && lot.expiresAt.getTime() <= now + EXPIRING_SOON_WINDOW_MS
    )
    .map(({ lot, remaining }) => ({ amount: remaining, expiresAt: lot.expiresAt }));

  return res.status(200).json({
    currentCredits: user.currentCredits,
    expiringSoon,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
