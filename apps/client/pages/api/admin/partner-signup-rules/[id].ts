import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { partnerSignupRuleRepository, withTransaction } from '@bike4mind/database';
import {
  ApiKeyScope,
  updatePartnerSignupRuleSchema,
  type AuditChange,
  type UpdatePartnerSignupRuleInput,
} from '@bike4mind/common';
import {
  invalidatePartnerRuleCache,
  assertKnownEntitlements,
  assertKnownSubscriptionPlan,
} from '@server/entitlements/partnerRules';
import { assertOrganizationExists } from '@server/entitlements/assertOrganizationExists';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { z } from 'zod';

interface RequestQuery {
  id: string;
}

type RuleField = keyof UpdatePartnerSignupRuleInput;

const diffRuleFields = <T extends Partial<Record<RuleField, unknown>>>(
  fields: RuleField[],
  before: T | null,
  after: T
): AuditChange[] =>
  fields.flatMap(field => {
    const previous = before?.[field] ?? null;
    const next = after[field] ?? null;
    return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ field, before: previous, after: next }];
  });

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .put(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const { id } = req.query as unknown as RequestQuery;
      if (!id) throw new BadRequestError('Rule id required');

      let data: ReturnType<typeof updatePartnerSignupRuleSchema.parse>;
      try {
        data = updatePartnerSignupRuleSchema.parse(req.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
        }
        throw error;
      }
      // Only present on a partial update that touches entitlements.
      if (data.entitlements) assertKnownEntitlements(data.entitlements);
      // Present (and non-null) only when the update sets/changes the org association.
      if (data.organizationId) await assertOrganizationExists(data.organizationId);
      // Only a changed plan is checked, so an admin can still edit or disable a rule whose plan
      // was removed from the catalog after it was saved.
      // Also the "before" side of the audit diff. Read outside the transaction, so a concurrent PUT
      // can leave `before` stale; acceptable for a last-writer-wins edit.
      const stored = await partnerSignupRuleRepository.findById(id);
      if (data.subscription && stored?.subscription?.priceId !== data.subscription.priceId) {
        assertKnownSubscriptionPlan(data.subscription);
      }

      const updated = await withTransaction(async () => {
        const rule = await partnerSignupRuleRepository.update({ id, ...data });
        // Null => the row was deleted between check and write (or never existed). 404 rather
        // than a 200 with an empty body. update() decides existence; the findById above only
        // reads the stored plan and the audit "before" values.
        if (!rule) throw new NotFoundError('Partner signup rule not found');
        await recordAdminActionFromRequest(req, {
          action: 'org.partner_signup_rule.updated',
          target: { kind: 'settings', id: rule.id, displayName: rule.domain },
          summary: `updated partner signup rule for ${rule.domain}`,
          // .strict() parse: every key in data is a RuleField.
          changes: diffRuleFields(Object.keys(data) as RuleField[], stored, rule),
        });
        return rule;
      });

      // A conditions change (credits/entitlements/enabled) must apply now, not after the TTL.
      invalidatePartnerRuleCache();

      res.status(200).json(updated);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const { id } = req.query as unknown as RequestQuery;
      if (!id) throw new BadRequestError('Rule id required');

      const existing = await partnerSignupRuleRepository.findById(id);
      if (!existing) throw new NotFoundError('Partner signup rule not found');

      // Hard delete: rules are config, not user data, and removing the row frees the
      // unique domain so the same partner can be re-added later without a revive path.
      await withTransaction(async () => {
        await partnerSignupRuleRepository.delete(id);
        await recordAdminActionFromRequest(req, {
          action: 'org.partner_signup_rule.deleted',
          target: { kind: 'settings', id: existing.id, displayName: existing.domain },
          summary: `deleted partner signup rule for ${existing.domain}`,
          details: {
            domain: existing.domain,
            organizationId: existing.organizationId ?? null,
            entitlements: existing.entitlements,
            enabled: existing.enabled,
          },
        });
      });
      invalidatePartnerRuleCache();

      res.status(200).json({ success: true });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
