// GET/PUT /api/organizations/:id/alert-settings
// The org's budget and low-balance alert thresholds. Billing owner, current appointed org admin,
// or platform admin (canManageMemberCreditBudgets in @bike4mind/common).

import {
  ORG_ALERT_MAX_PERCENT_THRESHOLDS,
  canManageMemberCreditBudgets,
  type IOrgBudgetAlerts,
  type IOrganizationDocument,
} from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { clearOrgBudgetAlertCache } from '@bike4mind/server-utils/organizations/evaluateOrgBudget';
import { z } from 'zod';

const bodySchema = z
  .object({
    enabled: z.boolean(),
    monthlyBudgetCredits: z.number().int().positive().nullable(),
    percentThresholds: z.array(z.number().int().min(1).max(100)).max(ORG_ALERT_MAX_PERCENT_THRESHOLDS),
    lowBalanceCredits: z.number().int().min(0).nullable(),
  })
  .strict();

type Req = { query: { id?: unknown }; user?: { id: string; isAdmin?: boolean | null } };

/** 404 for a caller who may not manage the org, so the route is not an existence oracle. */
async function loadManagedOrg(req: Req): Promise<IOrganizationDocument> {
  const organizationId = req.query.id;
  if (typeof organizationId !== 'string' || !organizationId) throw new BadRequestError('Invalid organization id');
  const organization = await organizationRepository.findById(organizationId);
  if (!organization || !canManageMemberCreditBudgets(req.user!, organization)) {
    throw new NotFoundError('Organization not found');
  }
  return organization;
}

// Browser sessions only (no API keys): alert thresholds are org billing policy.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organization = await loadManagedOrg(req);
      return res.json({ budgetAlerts: organization.budgetAlerts ?? null });
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organization = await loadManagedOrg(req);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Invalid alert settings');

      const budgetAlerts: IOrgBudgetAlerts = {
        ...parsed.data,
        percentThresholds: [...new Set(parsed.data.percentThresholds)].sort((a, b) => a - b),
      };
      await organizationRepository.update({ id: organization.id, budgetAlerts });
      // This instance's evaluator would otherwise keep the old thresholds for its cache TTL.
      clearOrgBudgetAlertCache(organization.id);

      await recordAdminActionFromRequest(req, {
        action: 'org.budget_alerts.updated',
        actorScope: 'organization',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
        summary: 'updated the budget alert settings',
        changes: [{ field: 'budgetAlerts', before: organization.budgetAlerts ?? null, after: budgetAlerts }],
      });

      return res.json({ budgetAlerts });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
