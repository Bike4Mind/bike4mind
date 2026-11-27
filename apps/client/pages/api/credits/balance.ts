import { creditLotRepository } from '@bike4mind/database';
import { CreditHolderType, pendingCreditExpiries } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';

const EXPIRING_SOON_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// SPA-only. API keys read their balance through the GET /api/v1/credits contract.
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const { user } = req;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const lots = await creditLotRepository.findByOwner(user.id, CreditHolderType.User);
  const now = Date.now();
  const expiringSoon = pendingCreditExpiries(lots, user.currentCredits).filter(
    ({ expiresAt }) => expiresAt.getTime() > now && expiresAt.getTime() <= now + EXPIRING_SOON_WINDOW_MS
  );

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
