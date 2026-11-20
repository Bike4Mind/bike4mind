import { AdminNoteIdSchema, BadRequestError, ConflictError, ForbiddenError, isFullAdmin } from '@bike4mind/common';
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
import * as z from 'zod';

const RoleChangeSchema = z.object({ isAdmin: z.boolean(), reason: z.unknown().optional() });

const ROLE_CHANGED_MESSAGE = 'The role changed. Reload the profile before trying again.';

/**
 * Grants or revokes the Super Admin role (`isAdmin`). Full admins only, session-only, step-up gated,
 * with a required reason and a strict audit entry. The generic user update route refuses `isAdmin`, so
 * this is the only path that changes the role. Delegated `adminPermissions` live on `./permissions`.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PUT: 'settings:manage' } })
  .use(csrfProtection())
  .put(async (req, res) => {
    // settings:manage only admits the request; the role itself stays with full admins.
    if (!isFullAdmin(req.user)) throw new ForbiddenError('Only full administrators can change the admin role');
    const parsed = RoleChangeSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Send isAdmin as true or false');
    const { isAdmin } = parsed.data;

    // Checked before the reason, so a self-change is always recorded as denied.
    const targetId = AdminNoteIdSchema.safeParse(req.query.userId);
    if (targetId.success && isSelfOrImpersonator(req.user, targetId.data)) {
      await denySelfAdminAction(req, {
        action: 'user.role.denied',
        attempted: isAdmin ? 'user.role.admin_granted' : 'user.role.admin_revoked',
        target: { kind: 'user', id: targetId.data, displayName: targetId.data },
        message: 'Admins cannot change their own role.',
      });
    }
    const reason = parseAdminActionReason(parsed.data.reason);

    const result = await withTransaction(async () => {
      const { userId, user } = await noteSubject(req, 'settings:manage');
      if (!!user.isAdmin === isAdmin) return { isAdmin };

      await requireStepUp(req);
      // Writing the actor's own row makes two admins demoting each other collide on a shared document,
      // so the transaction retries instead of both committing; it also re-checks the actor still holds
      // the role. See the lockout guard below.
      const actor = await User.updateOne({ _id: req.user.id, isAdmin: true }, { $set: { updatedAt: new Date() } });
      if (actor.matchedCount !== 1) throw new ForbiddenError('Only full administrators can change the admin role');

      // Lockout guard: never remove the only remaining Super Admin. Read inside the transaction so a
      // retry sees the committed state.
      if (!isAdmin && (await User.countDocuments({ isAdmin: true })) <= 1) {
        throw new BadRequestError('Cannot remove the last remaining Super Admin.');
      }

      const write = await User.updateOne(
        { _id: userId, isAdmin: isAdmin ? { $ne: true } : true },
        { $set: { isAdmin } },
        { runValidators: true }
      );
      if (write.matchedCount !== 1) throw new ConflictError(ROLE_CHANGED_MESSAGE);

      // Strict entry: a failed audit write aborts the transaction, so the role never changes unrecorded.
      await recordAdminActionFromRequest(req, {
        action: isAdmin ? 'user.role.admin_granted' : 'user.role.admin_revoked',
        target: { kind: 'user', id: userId, displayName: user.name || user.username || userId },
        summary: isAdmin ? 'granted the admin role' : 'revoked the admin role',
        reason,
        changes: [{ field: 'isAdmin', before: !isAdmin, after: isAdmin }],
      });
      return { isAdmin };
    });
    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } } };
export default handler;
