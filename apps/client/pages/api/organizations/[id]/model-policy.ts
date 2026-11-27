// GET/PUT/DELETE /api/organizations/:id/model-policy
// The org's allowlist of providers, models and tools (built-in or contributed) (OrgModelPolicySchema). managePolicies
// holder or platform admin (verifyOrgPermission). DELETE removes the policy so the org is unrestricted.

import { b4mLLMTools, OrgModelPolicySchema } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  diffOrgModelPolicy,
  resetOrgModelPolicy,
  setOrgModelPolicy,
  toOrgModelPolicyView,
} from '@server/organizations/orgModelPolicy';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';
import { premiumLlmTools } from '@bike4mind/server-utils/premium-generated/premiumLlmTools.generated';
import type { Request } from 'express';

type OrgRequest = Request<{}, unknown, unknown, { id?: string }>;

const orgIdOf = (req: OrgRequest): string => (typeof req.query.id === 'string' ? req.query.id : '');

// Contributed tools are governed beyond the built-in enum and only the server knows them, so the form lists them from
// here and a write must name a tool from one of the two sets.
const contributedTools = Object.keys(premiumLlmTools);
const knownTools: ReadonlySet<string> = new Set([...b4mLLMTools.options, ...contributedTools]);
const withContributedTools = <T extends object>(view: T) => ({ ...view, contributedTools });
const WritablePolicySchema = OrgModelPolicySchema.refine(
  policy => (policy.allowedTools ?? []).every(tool => knownTools.has(tool)),
  { message: 'Unknown tool name', path: ['allowedTools'] }
);

const recordChange = (
  req: OrgRequest,
  org: { id: string; name: string },
  changes: ReturnType<typeof diffOrgModelPolicy>,
  summary: string
) =>
  recordAdminActionFromRequest(req, {
    action: 'org.model_policy.updated',
    actorScope: 'organization',
    target: { kind: 'organization', id: org.id, displayName: org.name },
    summary,
    changes,
  });

type PolicyChange = { kind: 'replace'; body: unknown } | { kind: 'reset' };

async function changePolicy(req: OrgRequest, change: PolicyChange) {
  const { organization, changes, changed, view } = await withTransaction(async () => {
    // Re-read authorization and the before value on every transaction attempt.
    const organization = await verifyOrgPermission(req.user!, orgIdOf(req), 'managePolicies');
    const policy =
      change.kind === 'reset' ? OrgModelPolicySchema.parse({}) : parseOrBadRequest(WritablePolicySchema, change.body);
    const before = toOrgModelPolicyView(organization.modelPolicy);
    const changes = diffOrgModelPolicy(before, policy);
    const changed = changes.length > 0 || before.invalidStored;
    if (change.kind === 'reset') {
      if (organization.modelPolicy !== undefined && organization.modelPolicy !== null) {
        await resetOrgModelPolicy(organization.id);
      }
    } else if (changed) {
      await setOrgModelPolicy(organization.id, policy);
    }
    if (changed) {
      await recordOrganizationAuditEvent({
        organizationId: organization.id,
        actorUserId: req.user!.impersonatedBy ?? req.user!.id,
        action: 'policy.updated',
        targetId: 'model-policy',
      });
    }
    return { organization, changes, changed, view: changed ? toOrgModelPolicyView(policy) : before };
  });
  if (changed) {
    await recordChange(
      req,
      organization,
      changes,
      change.kind === 'reset' ? 'reset the model and tool policy to unrestricted' : 'updated the model and tool policy'
    );
  }
  return view;
}

// Session only: an org API key must not be able to lift its own org's restriction.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgPermission(req.user!, orgIdOf(req), 'managePolicies');
      return res.json(withContributedTools(toOrgModelPolicyView(org.modelPolicy)));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      return res.json(withContributedTools(await changePolicy(req, { kind: 'replace', body: req.body })));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      return res.json(withContributedTools(await changePolicy(req, { kind: 'reset' })));
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
