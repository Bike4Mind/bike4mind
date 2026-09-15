import { AnalyticsEventPayloads } from '@server/types/analytics';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';

const handler = baseApi().post(async (req: Request<{}, unknown, Omit<AnalyticsEventPayloads, 'userId'>>, res) => {
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
