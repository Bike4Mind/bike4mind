import type { OAuthClientUsageStats } from '@bike4mind/common';
import { OAuthClientModel } from './OAuthClientModel';
import { OAuthClientSignInModel } from './OAuthClientSignInModel';
import { User, signupClientIdMatch } from './UserModel';

const DAY_MS = 24 * 60 * 60 * 1000;

interface WindowCounts {
  _id: string;
  d7: number;
  d30: number;
}

const windowedCounts = (groupBy: string, timeField: string, since7d: Date) => ({
  $group: {
    _id: groupBy,
    d30: { $sum: 1 },
    d7: { $sum: { $cond: [{ $gte: [timeField, since7d] }, 1, 0] } },
  },
});

export const signupsMatch = (clientIds: string[], since: Date) => ({
  $match: { ...signupClientIdMatch({ $in: clientIds }), createdAt: { $gte: since } },
});

export const signInsMatch = (clientIds: string[], since: Date) => ({
  $match: { clientId: { $in: clientIds }, lastSignInAt: { $gte: since } },
});

/** Sign-ups and active users per registered client over the last 7 and 30 days; clients with no rows get zeros. */
export async function getOAuthClientUsageStats(now = new Date()): Promise<OAuthClientUsageStats> {
  const clientIds = (await OAuthClientModel.find().select('clientId').lean().exec()).map(c => c.clientId);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);
  const since30d = new Date(now.getTime() - 30 * DAY_MS);

  const [signups, signIns] = await Promise.all([
    User.aggregate<WindowCounts>([
      signupsMatch(clientIds, since30d),
      windowedCounts('$signupClientId', '$createdAt', since7d),
    ]),
    OAuthClientSignInModel.aggregate<WindowCounts>([
      signInsMatch(clientIds, since30d),
      windowedCounts('$clientId', '$lastSignInAt', since7d),
    ]),
  ]);

  const stats: OAuthClientUsageStats = {};
  for (const id of clientIds) {
    stats[id] = { signups7d: 0, signups30d: 0, activeUsers7d: 0, activeUsers30d: 0 };
  }
  for (const row of signups) {
    if (stats[row._id]) Object.assign(stats[row._id], { signups7d: row.d7, signups30d: row.d30 });
  }
  for (const row of signIns) {
    if (stats[row._id]) Object.assign(stats[row._id], { activeUsers7d: row.d7, activeUsers30d: row.d30 });
  }
  return stats;
}
