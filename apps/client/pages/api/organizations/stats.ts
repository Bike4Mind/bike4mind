import { IUserDocument } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';
import { Request } from 'express';
import { Organization, organizationRepository } from '@bike4mind/database/infra';
import { UserActivityCounter } from '@bike4mind/database/auth';
import { isValidObjectId } from '@server/utils/objectId';

const OrganizationStatsSchema = z.object({
  organizationIds: z.array(z.string()),
});

const handler = baseApi().get<Request<{}, {}, {}, Record<string, string>>>(
  asyncHandler(async (req, res) => {
    const { organizationIds } = OrganizationStatsSchema.parse(qs.parse(req.query));

    // The ids are caller-supplied, so intersect them with the caller's own membership before
    // querying: this route previously returned the name and login/export activity of ANY
    // organization to any authenticated caller, making it an existence-and-name oracle over the
    // whole tenant list. Filtering the input (rather than rejecting the request) keeps the
    // response indistinguishable from one naming ids that simply do not exist - an unauthorized id
    // is absent from the map exactly as a nonexistent one is.
    const memberOrgIds = req.user.isAdmin
      ? null
      : new Set(await organizationRepository.findMembershipOrgIds(req.user.id));
    const visibleOrganizationIds = memberOrgIds ? organizationIds.filter(id => memberOrgIds.has(id)) : organizationIds;

    const organizations = await Organization.find({
      // One uncastable id rejects the whole $in, taking the valid rows with it. Such an id
      // could never have matched, so drop it rather than fail the request.
      _id: { $in: visibleOrganizationIds.filter(isValidObjectId) },
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

    return res.json(statsMap);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
