// GET/PUT /api/organizations/:id/my-notification-prefs
// The caller's own org alert opt-ins. Only alert recipients - the owner and current appointed
// admins - have prefs; the dispatcher (server-utils organizations/orgAlertDispatcher.ts) reads them.

import { ApiKeyScope, ORG_ALERT_KINDS, resolveOrgAlertOptIn, type OrgAlertKind } from '@bike4mind/common';
import { orgAdminNotificationPrefRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

const bodySchema = z
  .object({
    kinds: z.object(Object.fromEntries(ORG_ALERT_KINDS.map(kind => [kind, z.boolean().optional()]))).strict(),
  })
  .strict();

type Req = { query: { id?: unknown }; user?: { id: string } };

/** Same "current admin" rule as the dispatcher; a platform admin is not a recipient. 404 otherwise. */
async function loadRecipientRole(req: Req): Promise<{ organizationId: string; role: 'owner' | 'manager' }> {
  const organizationId = req.query.id;
  if (typeof organizationId !== 'string' || !organizationId) throw new BadRequestError('Invalid organization id');
  const organization = await organizationRepository.findById(organizationId);
  const userId = req.user!.id;
  if (organization && !organization.personal) {
    if (organization.userId === userId) return { organizationId, role: 'owner' };
    const isCurrentAdmin =
      (organization.adminUserIds ?? []).includes(userId) &&
      (organization.users ?? []).some(member => member.userId === userId);
    if (isCurrentAdmin) return { organizationId, role: 'manager' };
  }
  throw new NotFoundError('Organization not found');
}

async function effectivePrefs(organizationId: string, userId: string, role: 'owner' | 'manager') {
  const row = await orgAdminNotificationPrefRepository.getForUser(organizationId, userId);
  return Object.fromEntries(ORG_ALERT_KINDS.map(kind => [kind, resolveOrgAlertOptIn(role, row, kind)])) as Record<
    OrgAlertKind,
    boolean
  >;
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { organizationId, role } = await loadRecipientRole(req);
      return res.json({ role, kinds: await effectivePrefs(organizationId, req.user!.id, role) });
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { organizationId, role } = await loadRecipientRole(req);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Invalid notification preferences');

      await orgAdminNotificationPrefRepository.upsertForUser(organizationId, req.user!.id, parsed.data.kinds);
      return res.json({ role, kinds: await effectivePrefs(organizationId, req.user!.id, role) });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
