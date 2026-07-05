// GET /api/organizations
// Index route to get all organizations

import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import qs from 'qs';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';

const handler = baseApi()
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const user = req.user;

    const result = await organizationService.search(user, qs.parse(req.query) as any, {
      db: {
        organizations: organizationRepository,
      },
    });

    return res.json(result);
  })
  .post(async (req, res) => {
    const organization = await organizationService.create(
      req.user,
      {
        ...req.body,
        stripeCustomerId: null,
      },
      {
        db: {
          organizations: organizationRepository,
        },
      }
    );

    return res.status(201).json(organization);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
