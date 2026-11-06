// GET/PUT/DELETE /api/organizations/:id/custom-mcp/policy
// The org's custom MCP connector policy (mode, including the `off` kill switch, host lists,
// requireApprovalForAll and the rest of CustomMcpPolicySchema). Owner, current manager or platform
// admin (verifyOrgAccess). DELETE drops the override so the org inherits the platform value.

import { CustomMcpPolicySchema } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  getOrgCustomMcpPolicy,
  readOrgCustomMcpPolicyOverride,
  resetOrgCustomMcpPolicy,
  setOrgCustomMcpPolicy,
} from '@server/mcpConnections/orgPolicy';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import type { Request } from 'express';

type OrgRequest = Request<{}, unknown, unknown, { id?: string }>;

const orgIdOf = (req: OrgRequest): string => (typeof req.query.id === 'string' ? req.query.id : '');

const recordChange = (
  req: OrgRequest,
  org: { id: string; name: string },
  before: string | null,
  after: string | null,
  summary: string
) =>
  recordAdminActionFromRequest(req, {
    action: 'org.custom_mcp_policy.updated',
    actorScope: 'organization',
    target: { kind: 'organization', id: org.id, displayName: org.name },
    summary,
    changes: [{ field: 'customMcpPolicy', before, after }],
  });

/**
 * The stored override as the schema reads it today, so a field added with a default later does not
 * make re-saving the same policy look like a change. A row the schema refuses is returned as stored.
 */
const normalizeStored = (stored: string | null): string | null => {
  if (stored === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return stored;
  }
  const parsed = CustomMcpPolicySchema.safeParse(raw);
  return parsed.success ? JSON.stringify(parsed.data) : stored;
};

// Session only: this is the org's kill switch for third-party tool servers, not something an
// API key should be able to reopen.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      return res.json(await getOrgCustomMcpPolicy(org.id));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      const policy = parseOrBadRequest(CustomMcpPolicySchema.strict(), req.body);
      const before = await readOrgCustomMcpPolicyOverride(org.id);
      const after = await setOrgCustomMcpPolicy(org.id, policy);
      if (normalizeStored(before) !== after) {
        await recordChange(req, org, before, after, 'updated the custom MCP connector policy');
      }
      return res.json(await getOrgCustomMcpPolicy(org.id));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgAccess(req.user!, orgIdOf(req));
      const before = await readOrgCustomMcpPolicyOverride(org.id);
      await resetOrgCustomMcpPolicy(org.id);
      // Resetting an org that has no override changes nothing, so it is not an admin change.
      if (before !== null) {
        await recordChange(req, org, before, null, 'reset the custom MCP connector policy to the platform default');
      }
      return res.json(await getOrgCustomMcpPolicy(org.id));
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
