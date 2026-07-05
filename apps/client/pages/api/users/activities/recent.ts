import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { CounterLog } from '@bike4mind/database';
import { UnauthorizedError } from '@server/utils/errors';

const handler = baseApi().get(async (req, res) => {
  const coverage = req.query.coverage as 'all' | 'important' | undefined;
  const userId = req.query.userId as string | undefined;

  // If querying another user's activities, require admin
  if (userId && userId !== req.user.id && !req.user.isAdmin) {
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
