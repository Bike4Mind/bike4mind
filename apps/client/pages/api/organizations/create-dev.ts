/**
 * DEV-ONLY endpoint to create an organization without going through Stripe
 * This bypasses the subscription flow for local development testing
 */

import { organizationRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { isDevelopment } from '@server/utils/config';
import { Request } from 'express';
import { z } from 'zod';
import { organizationService } from '@bike4mind/services';
import { ORGANIZATION_SUBSCRIPTION_MIN_SEATS } from '@client/lib/subscriptions/constants';

const CreateDevOrgSchema = z.object({
  name: z.string().min(1),
  seats: z.number().min(ORGANIZATION_SUBSCRIPTION_MIN_SEATS).optional(),
});

const handler = baseApi().post<Request<{}, {}, z.infer<typeof CreateDevOrgSchema>>>(async (req, res) => {
  if (!isDevelopment()) {
    throw new BadRequestError('This endpoint is only available in development mode');
  }

  const { name, seats = ORGANIZATION_SUBSCRIPTION_MIN_SEATS } = CreateDevOrgSchema.parse(req.body);

  req.logger.info(`[DEV] Creating organization without Stripe: ${name}`);

  const organization = await organizationService.create(
    req.user,
    {
      name,
      seats,
      personal: false,
      stripeCustomerId: null, // No Stripe customer in dev mode
    },
    {
      db: {
        organizations: organizationRepository,
      },
    }
  );

  req.logger.info(`[DEV] ✅ Organization created:`, {
    id: organization.id,
    name: organization.name,
    seats: organization.seats,
  });

  return res.status(200).json({
    organization: {
      id: organization.id,
      name: organization.name,
      seats: organization.seats,
    },
  });
});

export default handler;
