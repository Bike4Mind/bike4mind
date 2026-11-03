import { accessibleBy } from '@casl/mongoose';
import { Permission, userActivityCounterListResponseSchema } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import { UserActivityCounter } from '@bike4mind/database';
import { respond } from '@server/utils/respond';

const handler = baseApi().get<Request<{}, unknown, unknown, { id: string }>>(async (req, res) => {
  const userId = req.query.id;
  const query = accessibleBy(req.ability!, Permission.read).ofType(UserActivityCounter);
  const userActivityCounters = await UserActivityCounter.find({ userId, ...query });
  return respond(res, userActivityCounterListResponseSchema, userActivityCounters);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
