// GET /api/organizations
// Index route to get all organizations

import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import qs from 'qs';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { toSafeOrganizations } from '@bike4mind/common';

const handler = baseApi()
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const user = req.user;

    const params = qs.parse(req.query) as any;
    // Scope non-admins to their own organizations so this search cannot enumerate
    // other tenants. Admin org-management UIs may still query across tenants.
    if (!user.isAdmin) {
      params.filters = { ...(params.filters ?? {}), userId: user.id };
    }

    const result = await organizationService.search(user, params, {
      db: {
        organizations: organizationRepository,
      },
    });

    return res.json({
      ...result,
      data: toSafeOrganizations(result.data, { userId: user.id, isAdmin: user.isAdmin }),
    });
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
