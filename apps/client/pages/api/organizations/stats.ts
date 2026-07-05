import { IUserDocument } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';
import { Request } from 'express';
import { Organization } from '@bike4mind/database/infra';
import { UserActivityCounter } from '@bike4mind/database/auth';

const OrganizationStatsSchema = z.object({
  organizationIds: z.array(z.string()),
});

const handler = baseApi().get<Request<{}, {}, {}, Record<string, string>>>(
  asyncHandler(async (req, res) => {
    const { organizationIds } = OrganizationStatsSchema.parse(qs.parse(req.query));

    const organizations = await Organization.find({
      _id: { $in: organizationIds },
    })
      .select('id name users')
      .populate('users.userId', 'loginRecords counters');

    const statsMap: {
      [key: string]: {
        name: string;
        totalLogins: number;
        mostRecentLogin: Date | null;
        totalExports: number;
      };
    } = {};

    for (const organization of organizations) {
      statsMap[organization.id] ??= {
        name: organization.name,
        totalLogins: 0,
        mostRecentLogin: null,
        totalExports: 0,
      };
      statsMap[organization.id].mostRecentLogin = organization.users.reduce<null | Date>((mostRecent, user) => {
        const u = user.userId as unknown as IUserDocument;

        if (!u.loginRecords) return mostRecent;
        const loginTime = u.loginRecords.reduce(
          (max, record) => (record.loginTime > (max ?? new Date(0)) ? record.loginTime : max),
          mostRecent
        );
        return loginTime;
      }, statsMap[organization.id].mostRecentLogin);

      const counters = await UserActivityCounter.find({
        userId: { $in: organization.users.map(u => (u.userId as unknown as IUserDocument).id) },
      });

      for (const counter of counters) {
        const stats = statsMap[organization.id];
        if (counter.action === 'numLogins') {
          stats.totalLogins += counter.count;
        } else if (counter.tags?.includes('export')) {
          stats.totalExports += counter.count;
        }
      }
    }

    console.log('Stats Map:', JSON.stringify(statsMap, null, 2));

    return res.json(statsMap);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
