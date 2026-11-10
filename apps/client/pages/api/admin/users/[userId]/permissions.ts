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
  type AdminPermissionId,
} from '@bike4mind/common';
import { User, withTransaction } from '@bike4mind/database';
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

const sameSet = (left: readonly AdminPermissionId[], right: readonly AdminPermissionId[]) =>
  left.length === right.length && left.every(id => right.includes(id));

const describeChange = (granted: readonly AdminPermissionId[], revoked: readonly AdminPermissionId[]) =>
  [granted.length && `granted ${granted.join(', ')}`, revoked.length && `revoked ${revoked.join(', ')}`]
    .filter(Boolean)
    .join('; ');

/**
 * Edits a user's delegated `adminPermissions`. Full admins only, and never `isAdmin`: the role stays
 * on the user update route, so this endpoint cannot demote anyone, the last full admin included.
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

    const adminPermissions = await withTransaction(async () => {
      const { userId, user } = await noteSubject(req, 'settings:manage');
      if (isFullAdmin(user)) {
        throw new BadRequestError('Full admins hold every permission. Change their role to limit their access.');
      }
      assertCanActOnAdminTarget(req.user, user, 'change admin permissions of');
      assertCanGrantAdminAccess(req.user, { adminPermissions: after });
      // Compare the cleaned set the editor showed; the write below replaces the raw stored array.
      const stored: readonly string[] = user.adminPermissions ?? [];
      if (!sameSet(before, sortAdminPermissions(stored))) {
        throw new ConflictError('Admin permissions changed. Reload the profile before trying again.');
      }
      if (sameSet(before, after)) return before;

      await requireStepUp(req);
      const result = await User.updateOne(
        { _id: userId, adminPermissions: stored.length ? stored : { $in: [null, []] } },
        { $set: { adminPermissions: after } },
        { runValidators: true }
      );
      if (result.matchedCount !== 1) {
        throw new ConflictError('Admin permissions changed. Reload the profile before trying again.');
      }
      const granted = after.filter(id => !before.includes(id));
      const revoked = before.filter(id => !after.includes(id));
      await recordAdminActionFromRequest(req, {
        action: 'user.permissions.updated',
        target: { kind: 'user', id: userId, displayName: user.name || user.username || userId },
        summary: describeChange(granted, revoked),
        reason,
        changes: [{ field: 'adminPermissions', before: [...stored], after }],
        details: { granted, revoked },
      });
      return after;
    });
    return res.json({ adminPermissions });
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
