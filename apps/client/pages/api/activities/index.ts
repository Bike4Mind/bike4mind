import { Request, Response } from 'express';
import { activityRepository, Project } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { PaginatedResponse, Permission } from '@bike4mind/common';
import { IActivityDocument } from '@bike4mind/common';
import { accessibleBy } from '@casl/mongoose';

interface QueryParams {
  projectId?: string;
  page?: string;
  limit?: string;
}

const handler = baseApi().get(async (req: Request<{}, {}, {}, QueryParams>, res: Response) => {
  const userId = req.user.id;
  const { page = '1', limit = '10' } = req.query;

  const currentPage = parseInt(page, 10);
  const limitNumber = parseInt(limit, 10);
  const skip = (currentPage - 1) * limitNumber;

  // Get the user's activity feed with pagination

  const projectScope = accessibleBy(req.ability!, Permission.read).ofType(Project);
  const userFeed = await activityRepository.findUserFeed(userId, projectScope, skip, limitNumber);
  const activities = userFeed.activities;
  const total = userFeed.totalCount;

  const response: PaginatedResponse<IActivityDocument> = {
    data: activities,
    meta: {
      currentPage,
      totalPages: Math.ceil(total / limitNumber),
      total,
    },
  };

  return res.json(response);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
