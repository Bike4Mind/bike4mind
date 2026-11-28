import type { Request } from 'express';
import { NotFoundError, assertCanActOnAdminTarget, oauthClientRoleAssignmentInputSchema } from '@bike4mind/common';
import {
  assignOAuthClientRole,
  listUserOAuthClientRoles,
  unassignOAuthClientRole,
  userRepository,
} from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const readUserId = (req: Request): string => {
  const { userId } = req.query;
  if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');
  return userId;
};

/** Parses { clientId, role, reason } and refuses a delegated admin acting on an account with admin access. */
const readChange = async (req: Request) => {
  const userId = readUserId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const input = parseOrBadRequest(oauthClientRoleAssignmentInputSchema, { clientId: body.clientId, role: body.role });
  const reason = parseAdminActionReason(body.reason);
  const target = await userRepository.findById(userId);
  if (!target) throw new NotFoundError('User not found');
  assertCanActOnAdminTarget(req.user, target, 'change the OAuth client roles of');
  return { userId, reason, ...input };
};

type RoleChange = Awaited<ReturnType<typeof unassignOAuthClientRole>>;

// Targets the user so the change shows on their admin timeline; the client is named in the details.
const userTarget = (user: RoleChange['user']) => ({
  kind: 'user' as const,
  id: user.id,
  displayName: user.email ?? user.name ?? user.id,
});

const auditDetails = (client: RoleChange['client'], role: RoleChange['role'], user: RoleChange['user']) => ({
  oauthClientId: client.id,
  clientId: client.clientId,
  clientName: client.name,
  role: role.key,
  label: role.label,
  userId: user.id,
  userEmail: user.email,
});

/**
 * GET / POST / DELETE /api/admin/users/[userId]/oauth-client-roles - the user's roles per OAuth client;
 * POST assigns one and DELETE removes one, each audited against the user.
 */
const handler = adminApi({
  adminPermissions: { GET: ['support:read', 'settings:manage'], POST: 'settings:manage', DELETE: 'settings:manage' },
  auth: 'jwtOnly',
})
  .get(async (req, res) => {
    res.status(200).json(await listUserOAuthClientRoles(readUserId(req)));
  })
  .post(async (req, res) => {
    const { userId, clientId, role: key, reason } = await readChange(req);
    const { client, user, role, created } = await assignOAuthClientRole({
      userId,
      clientId,
      role: key,
      assignedBy: req.user.id,
    });

    if (created) {
      await recordAdminActionFromRequest(req, {
        action: 'oauth_client.role_assigned',
        target: userTarget(user),
        summary: `assigned the role ${role.key} on ${client.name} to the user`,
        reason,
        details: auditDetails(client, role, user),
      });
    }

    res.status(created ? 201 : 200).json({ clientId: client.clientId, role: role.key, created });
  })
  .delete(async (req, res) => {
    const { userId, clientId, role: key, reason } = await readChange(req);
    const { client, user, role } = await unassignOAuthClientRole({ userId, clientId, role: key });

    await recordAdminActionFromRequest(req, {
      action: 'oauth_client.role_unassigned',
      target: userTarget(user),
      summary: `removed the role ${role.key} on ${client.name} from the user`,
      reason,
      details: auditDetails(client, role, user),
    });

    res.status(200).json({ clientId: client.clientId, role: role.key });
  });

export const config = { api: { externalResolver: true } };
export default handler;
