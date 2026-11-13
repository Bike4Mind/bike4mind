// GET/PUT/DELETE /api/organizations/:id/model-policy
// The org's allowlist of providers, models and built-in tools (OrgModelPolicySchema). Owner, current
// manager or platform admin (verifyOrgAccess). DELETE removes the policy so the org is unrestricted.

import { OrgModelPolicySchema } from '@bike4mind/common';
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
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import type { Request } from 'express';

type OrgRequest = Request<{}, unknown, unknown, { id?: string }>;

const orgIdOf = (req: OrgRequest): string => (typeof req.query.id === 'string' ? req.query.id : '');

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
    const organization = await verifyOrgAccess(req.user!, orgIdOf(req));
    const policy =
      change.kind === 'reset' ? OrgModelPolicySchema.parse({}) : parseOrBadRequest(OrgModelPolicySchema, change.body);
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
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      return res.json(toOrgModelPolicyView(org.modelPolicy));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      return res.json(await changePolicy(req, { kind: 'replace', body: req.body }));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      return res.json(await changePolicy(req, { kind: 'reset' }));
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
