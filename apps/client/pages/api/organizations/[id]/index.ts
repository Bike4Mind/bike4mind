import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { partnerSignupRuleRepository, userRepository, withTransaction } from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
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

    // Wrapped in withTransaction (org-groups #1172/#1219): the member purge, the group
    // soft-deletes, and the org delete must commit together, or a partial failure leaves either
    // dangling group access or an org that never actually deletes. Repositories join the session
    // automatically via transactionAsyncLocalStorage.
    await withTransaction(() =>
      organizationService.deleteOrganization(
        req.user!,
        { id },
        {
          db: {
            organizations: organizationRepository,
            groups: groupRepository,
            users: userRepository,
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
      )
    );

    // Clear the dangling reference from any partner signup rule that pointed at this org, so
    // no future signup resolves to a deleted org. The rule survives (its entitlements/credits
    // still apply); only the org association is dropped. Cache invalidation makes it immediate.
    await partnerSignupRuleRepository.updateMany({ organizationId: id }, { organizationId: null });
    invalidatePartnerRuleCache();

    return res.json({ id });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
