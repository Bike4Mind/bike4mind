import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { CounterLog } from '@bike4mind/database';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { hasAdminPermission } from '@bike4mind/common';

const handler = baseApi().get(async (req, res) => {
  const coverage = req.query.coverage as 'all' | 'important' | undefined;
  const userId = req.query.userId as string | undefined;

  // Another user's activity feed is support data, shown in the admin Users view under support:read.
  if (userId && userId !== req.user.id && !hasAdminPermission(req.user, 'support:read')) {
    throw new UnauthorizedError('Unauthorized');
  }

  const activities = await userService.listRecentActivities(
    req.user,
    {
      coverage: coverage || 'important',
      userId,
    },
    {
      db: {
        counterLogs: CounterLog,
      },
    }
  );

  return res.json(activities);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
