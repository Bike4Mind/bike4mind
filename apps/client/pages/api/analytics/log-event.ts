import { CreditPurchaseEvents } from '@bike4mind/common';
import { AnalyticsEventPayloads } from '@server/types/analytics';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';

// Recorded only by start-payment and the Stripe webhook; support reads them as proof that an
// intent was created or granted, so a client must not be able to write them.
const SERVER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  CreditPurchaseEvents.CHECKOUT_STARTED,
  CreditPurchaseEvents.CREDITS_GRANTED,
  CreditPurchaseEvents.CREDITS_ALREADY_GRANTED,
]);

const handler = baseApi().post(async (req: Request<{}, unknown, Omit<AnalyticsEventPayloads, 'userId'>>, res) => {
  if (SERVER_ONLY_EVENTS.has(req.body?.type)) {
    throw new ForbiddenError('This event can only be recorded by the server');
  }

  const body = { ...req.body, userId: req.user?.id } as AnalyticsEventPayloads;

  await logEvent(body, { ability: req.ability });

  return res.status(204).send();
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
