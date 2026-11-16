import {
  AdminNoteIdSchema,
  AdminUserPermissionsChangeSchema,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  assertCanActOnAdminTarget,
  assertCanGrantAdminAccess,
  isFullAdmin,
  sortAdminPermissions,
  sortAdminRoleIds,
} from '@bike4mind/common';
import { User, adminRoleRepository, withTransaction } from '@bike4mind/database';
import { Types } from 'mongoose';
import { requireStepUp } from '@server/auth/stepUp';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { noteSubject } from '@server/users/adminUserNotes';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@bike4mind/server-utils/utils/adminAudit';

const sameSet = <T extends string>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length && left.every(id => right.includes(id));

const describeChange = (changes: {
  granted: readonly string[];
  revoked: readonly string[];
  rolesAdded: readonly string[];
  rolesRemoved: readonly string[];
}) =>
  [
    changes.granted.length && `granted ${changes.granted.join(', ')}`,
    changes.revoked.length && `revoked ${changes.revoked.join(', ')}`,
    changes.rolesAdded.length && `added to ${changes.rolesAdded.join(', ')}`,
    changes.rolesRemoved.length && `removed from ${changes.rolesRemoved.join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');

/**
 * Edits a user's delegated `adminPermissions` and, when the body names them, the admin roles they
 * hold (`adminRoleIds`, b4m-core/common adminRoles.ts). Holding a role grants its permissions, so
 * an assignment passes the same grant rules as a direct permission. Full admins only, and never
 * `isAdmin`: the role lives on `./role`, so this endpoint cannot demote anyone, the last full admin included.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PUT: 'settings:manage' } })
  .use(csrfProtection())
  .put(async (req, res) => {
    // settings:manage only admits the request; granting stays with full admins until delegates can grant.
    if (!isFullAdmin(req.user)) throw new ForbiddenError('Only full administrators can change admin permissions');
    const targetId = AdminNoteIdSchema.safeParse(req.query.userId);
    if (targetId.success && isSelfOrImpersonator(req.user, targetId.data)) {
      await denySelfAdminAction(req, {
        action: 'user.permissions.denied',
        attempted: 'user.permissions.updated',
        target: { kind: 'user', id: targetId.data, displayName: targetId.data },
        message: 'Admins cannot change their own admin permissions.',
      });
    }

    const parsed = AdminUserPermissionsChangeSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Choose admin permissions from the supported list');
    const reason = parseAdminActionReason(parsed.data.reason);
    const before = sortAdminPermissions(parsed.data.before);
    const after = sortAdminPermissions(parsed.data.adminPermissions);
    const rolesRequested = parsed.data.adminRoleIds !== undefined;
    const beforeRoleIds = sortAdminRoleIds(parsed.data.beforeAdminRoleIds ?? []);
    const afterRoleIds = sortAdminRoleIds(parsed.data.adminRoleIds ?? []);

    const result = await withTransaction(async () => {
      const { userId, user } = await noteSubject(req, 'settings:manage');
      if (isFullAdmin(user)) {
        throw new BadRequestError('Full admins hold every permission. Change their role to limit their access.');
      }
      assertCanActOnAdminTarget(req.user, user, 'change admin permissions of');
      const storedRoleIdsRaw = user.adminRoleIds ?? [];
      const storedRoleIds = sortAdminRoleIds(storedRoleIdsRaw.map(String));
      const nextRoleIds = rolesRequested ? afterRoleIds : storedRoleIds;
      const nextRoles = await adminRoleRepository.findByIds(nextRoleIds);
      if (rolesRequested && nextRoles.length !== nextRoleIds.length) {
        throw new BadRequestError('Choose admin roles that exist. Reload the profile before trying again.');
      }
      assertCanGrantAdminAccess(req.user, {
        adminPermissions: sortAdminPermissions([...after, ...nextRoles.flatMap(role => role.permissions)]),
      });
      // Compare the cleaned set the editor showed; the write below replaces the raw stored array.
      const stored: readonly string[] = user.adminPermissions ?? [];
      const rolesStale = rolesRequested && !sameSet(beforeRoleIds, storedRoleIds);
      if (!sameSet(before, sortAdminPermissions(stored)) || rolesStale) {
        throw new ConflictError('Admin permissions changed. Reload the profile before trying again.');
      }
      if (sameSet(before, after) && sameSet(storedRoleIds, nextRoleIds)) {
        return { adminPermissions: before, adminRoleIds: storedRoleIds };
      }

      await requireStepUp(req);
      const update = await User.updateOne(
        {
          _id: userId,
          adminPermissions: stored.length ? stored : { $in: [null, []] },
          ...(rolesRequested && { adminRoleIds: storedRoleIdsRaw.length ? storedRoleIdsRaw : { $in: [null, []] } }),
        },
        {
          $set: {
            adminPermissions: after,
            ...(rolesRequested && { adminRoleIds: nextRoleIds.map(id => new Types.ObjectId(id)) }),
          },
        },
        { runValidators: true }
      );
      if (update.matchedCount !== 1) {
        throw new ConflictError('Admin permissions changed. Reload the profile before trying again.');
      }
      const storedRoleNames = new Map(
        (await adminRoleRepository.findByIds(storedRoleIds)).map(role => [role.id, role.name])
      );
      const nameOf = (id: string) => storedRoleNames.get(id) ?? nextRoles.find(role => role.id === id)?.name ?? id;
      const changes = {
        granted: after.filter(id => !before.includes(id)),
        revoked: before.filter(id => !after.includes(id)),
        rolesAdded: nextRoleIds.filter(id => !storedRoleIds.includes(id)).map(nameOf),
        rolesRemoved: storedRoleIds.filter(id => !nextRoleIds.includes(id)).map(nameOf),
      };
      await recordAdminActionFromRequest(req, {
        action: 'user.permissions.updated',
        target: { kind: 'user', id: userId, displayName: user.name || user.username || userId },
        summary: describeChange(changes),
        reason,
        changes: [
          ...(sameSet(before, after) ? [] : [{ field: 'adminPermissions', before: [...stored], after }]),
          ...(sameSet(storedRoleIds, nextRoleIds)
            ? []
            : [{ field: 'adminRoleIds', before: storedRoleIds, after: nextRoleIds }]),
        ],
        details: changes,
      });
      return { adminPermissions: after, adminRoleIds: nextRoleIds };
    });
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
