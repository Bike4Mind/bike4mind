import { CreditPurchaseEvents, FirstRunEvents } from '@bike4mind/common';
import { AnalyticsEventPayloads } from '@bike4mind/server-utils/types/analytics/index';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { Request } from 'express';

// Server-authoritative payment and first-answer records must not be writable by clients.
const SERVER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  CreditPurchaseEvents.CHECKOUT_STARTED,
  CreditPurchaseEvents.CREDITS_GRANTED,
  CreditPurchaseEvents.CREDITS_ALREADY_GRANTED,
  FirstRunEvents.FIRST_ANSWER_CREDITS,
  FirstRunEvents.POLICIES_SHOWN,
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
