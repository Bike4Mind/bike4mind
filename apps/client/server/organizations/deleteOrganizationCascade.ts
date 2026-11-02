import type { IUserDocument, LakeAuditPrincipal } from '@bike4mind/common';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  integrationRequestRepository,
  partnerSignupRuleRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { groupRepository } from '@bike4mind/database/social';
import { organizationService } from '@bike4mind/services';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';

/**
 * Deletes an organization and everything hanging off it. The one org-delete path, shared by
 * DELETE /api/organizations/[id] and the account deletion sweep (an owner's sole-member orgs go with
 * the account). `principal` must be allowed to delete the org (its owner or an admin): deleteOrganization
 * checks it. Refused while the org has an active subscription.
 */
export async function deleteOrganizationCascade(
  principal: IUserDocument,
  id: string,
  { logger, auditPrincipal }: { logger: { warn: (msg: string) => void }; auditPrincipal?: LakeAuditPrincipal }
): Promise<void> {
  // Wrapped in withTransaction (org-groups #1172/#1219): the member purge, the group
  // soft-deletes, the members' lake-grant lapse, the user organizationId reset, and the org delete
  // must commit together, or a partial failure leaves dangling group or lake access or an org that
  // never actually deletes.
  // Repositories join the session automatically via transactionAsyncLocalStorage.
  await withTransaction(() =>
    organizationService.deleteOrganization(
      principal,
      { id },
      {
        db: {
          organizations: organizationRepository,
          groups: groupRepository,
          users: userRepository,
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
        },
        auditPrincipal,
        logger,
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
  // Same for roadmap integration requests: they are the members' own votes and stay. Best-effort:
  // the org is already gone, so a failure here must not turn the committed delete into a 500 a
  // retry cannot fix. The request keeps a dangling organizationId, which the admin demand list
  // already shows as a deleted organization.
  try {
    await integrationRequestRepository.clearOrganization(id);
  } catch (err) {
    logger.warn(`Failed to clear integration requests' organization for deleted organization ${id}: ${String(err)}`);
  }
}
