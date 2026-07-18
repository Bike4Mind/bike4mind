import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { organizationService } from '@bike4mind/services';
import { toSafeOrganization } from '@bike4mind/common';
import { Request } from 'express';
import { subscriptionRepository } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id!;

      const organization = await organizationService.get(
        req.user!,
        { id: orgId },
        {
          db: {
            organizations: organizationRepository,
          },
        }
      );

      return res
        .status(200)
        .json(toSafeOrganization(organization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id;

      const updatedOrganization = await organizationService.update(
        req.user!,
        { id: orgId, ...(req.body as any) },
        {
          db: {
            organizations: organizationRepository,
          },
        }
      );

      return res.json(toSafeOrganization(updatedOrganization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
    })
  )
  .delete<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
    const id = req.query.id;

    await organizationService.deleteOrganization(
      req.user!,
      { id },
      {
        db: {
          organizations: organizationRepository,
        },
        validation: {
          canDeleteOrganization: async organization => {
            const subscriptions = await subscriptionRepository.findActiveSubscriptionsByOwner(
              SubscriptionOwnerType.Organization,
              organization.id
            );
            return {
              canDelete: subscriptions.length === 0,
              reason: subscriptions.length > 0 ? 'Organization has active subscriptions' : undefined,
            };
          },
        },
      }
    );

    return res.json({ id });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
