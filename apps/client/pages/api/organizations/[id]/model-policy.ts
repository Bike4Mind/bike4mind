// GET/PUT/DELETE /api/organizations/:id/model-policy
// The org's allowlist of providers, models and built-in tools (OrgModelPolicySchema). Owner, current
// manager or platform admin (verifyOrgAccess). DELETE removes the policy so the org is unrestricted.

import { OrgModelPolicySchema } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  diffOrgModelPolicy,
  getOrgModelPolicy,
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
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      const policy = parseOrBadRequest(OrgModelPolicySchema, req.body);
      const changes = diffOrgModelPolicy(toOrgModelPolicyView(org.modelPolicy), policy);
      if (changes.length > 0) {
        await setOrgModelPolicy(org.id, policy);
        await recordChange(req, org, changes, 'updated the model and tool policy');
      }
      return res.json(await getOrgModelPolicy(org.id));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      const before = toOrgModelPolicyView(org.modelPolicy);
      const changes = diffOrgModelPolicy(before, OrgModelPolicySchema.parse({}));
      if (org.modelPolicy !== undefined && org.modelPolicy !== null) {
        await resetOrgModelPolicy(org.id);
      }
      if (changes.length > 0) {
        await recordChange(req, org, changes, 'reset the model and tool policy to unrestricted');
      }
      return res.json(await getOrgModelPolicy(org.id));
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
