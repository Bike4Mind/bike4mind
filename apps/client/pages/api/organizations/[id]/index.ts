import { z } from 'zod';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  creditLotRepository,
  creditTransactionRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  integrationRequestRepository,
  partnerSignupRuleRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { groupRepository } from '@bike4mind/database/social';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { assertDataLakeShareScope } from '@server/dataLakes/dataLakeScopes';
import { invalidatePartnerRuleCache } from '@server/entitlements/partnerRules';
import { creditService, organizationService } from '@bike4mind/services';
import { CreditHolderType, MAX_STORAGE_LIMIT_MB, toSafeOrganization } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { Request } from 'express';
import { subscriptionRepository } from '@server/models/Subscription';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const updateOrgBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  billingContact: z.string().optional(),
  // No bare coerce: it reads null (what JSON makes of NaN) and '' as 0, which would wipe the balance.
  currentCredits: z
    .union([z.number(), z.string().trim().min(1)])
    .pipe(z.coerce.number<string | number>().min(0))
    .optional(),
  systemPrompt: z.string().max(10000).optional(),
  maxCreditsPerMember: z.number().int().positive().nullable().optional(),
  storageLimit: z.number().min(0).max(MAX_STORAGE_LIMIT_MB).nullable().optional(),
});

/**
 * A platform admin's edit of the org balance, applied as a ledger row plus a strict audit
 * entry. Must run inside the caller's transaction, so no admin balance change lands without
 * either (or without the profile update). The profile update never writes currentCredits itself.
 */
const applyAdminCreditEdit = async (req: Request, orgId: string, requestedBalance: number) => {
  const creditAdapters = {
    db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
    creditHolderMethods: organizationRepository,
  };

  // Read the balance inside the transaction so a retry after a write conflict recomputes the delta.
  const organization = await organizationRepository.findById(orgId);
  if (!organization) throw new NotFoundError('Organization not found');

  const previousBalance = organization.currentCredits ?? 0;
  const credits = requestedBalance - previousBalance;
  if (credits === 0) return;

  const reason = parseAdminActionReason((req.body as { creditReason?: unknown } | undefined)?.creditReason);
  const metadata = { adminUserId: req.user!.id, reason, previousBalance, source: 'admin_org_edit' };
  const ledgerEntry = {
    ownerId: organization.id,
    ownerType: CreditHolderType.Organization,
    credits: Math.abs(credits),
    reason: 'admin_adjustment',
    description: reason,
    metadata,
  } as const;

  const { creditTransactionId } =
    credits > 0
      ? await creditService.addCreditsWithLedgerRow({ ...ledgerEntry, type: 'generic_add' }, creditAdapters)
      : await creditService.subtractCreditsWithLedgerRow({ ...ledgerEntry, type: 'generic_deduct' }, creditAdapters);
  await recordAdminActionFromRequest(req, {
    action: 'org.credits.adjusted',
    target: { kind: 'organization', id: organization.id, displayName: organization.name },
    summary: `${credits > 0 ? 'granted' : 'deducted'} ${Math.abs(credits)} credits`,
    reason,
    changes: [{ field: 'currentCredits', before: previousBalance, after: requestedBalance }],
    details: { credits, ownerId: organization.userId },
    related: creditTransactionId ? { creditTransactionId } : undefined,
  });
};

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
      if (typeof orgId !== 'string' || !orgId) {
        throw new BadRequestError('Invalid organization id');
      }

      const { currentCredits, ...profile } = updateOrgBodySchema.parse(req.body);
      // Non-admins cannot move credits here; their value is ignored, as before.
      const updateProfile = () =>
        organizationService.update(
          req.user!,
          { ...profile, id: orgId },
          {
            db: {
              organizations: organizationRepository,
            },
          }
        );

      const updatedOrganization =
        req.user!.isAdmin && currentCredits !== undefined
          ? await withTransaction(async () => {
              await applyAdminCreditEdit(req, orgId, currentCredits);
              return updateProfile();
            })
          : await updateProfile();

      return res.json(toSafeOrganization(updatedOrganization, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
    })
  )
  .delete<Request<unknown, unknown, unknown, { id: string }>>(async (req, res) => {
    // In-handler so GET and PUT keep their scope behaviour: deleting the org lapses members' lake
    // grants and can hand lakes to the billing owner. No-ops for a session caller.
    assertDataLakeShareScope(req);

    const id = req.query.id;

    // Wrapped in withTransaction (org-groups #1172/#1219): the member purge, the group
    // soft-deletes, the members' lake-grant lapse, the user organizationId reset, and the org delete
    // must commit together, or a partial failure leaves dangling group or lake access or an org that
    // never actually deletes.
    // Repositories join the session automatically via transactionAsyncLocalStorage.
    await withTransaction(() =>
      organizationService.deleteOrganization(
        req.user!,
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
          auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo),
          logger: req.logger,
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
      req.logger.warn(
        `Failed to clear integration requests' organization for deleted organization ${id}: ${String(err)}`
      );
    }

    return res.json({ id });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
