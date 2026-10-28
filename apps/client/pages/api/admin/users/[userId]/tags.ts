import {
  AdminUserTagsChangeSchema,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  assertCanActOnAdminTarget,
} from '@bike4mind/common';
import { User, withTransaction } from '@bike4mind/database';
import { isManagedTag } from '@client/lib/entitlements/managedUserTags';
import { adminApi } from '@server/middlewares/adminApi';
import { noteSubject } from '@server/users/adminUserNotes';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PATCH: 'settings:manage' } }).patch(
  async (req, res) => {
    const parsed = AdminUserTagsChangeSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Use up to 100 distinct tags of 1 to 64 characters');
    const { before, tags } = parsed.data;
    await withTransaction(async () => {
      const { userId, user } = await noteSubject(req, 'settings:manage');
      assertCanActOnAdminTarget(req.user, user, 'change tags on');
      const managedBefore = (user.tags ?? []).filter(isManagedTag).sort();
      const managedAfter = tags.filter(isManagedTag).sort();
      if (JSON.stringify(managedBefore) !== JSON.stringify(managedAfter)) {
        throw new ForbiddenError('Use the role or product access action to change managed tags');
      }
      const result = await User.updateOne(
        { _id: userId, tags: before.length ? before : { $in: [null, []] } },
        { $set: { tags } },
        { runValidators: true }
      );
      if (result.matchedCount !== 1) throw new ConflictError('Tags changed. Reload the profile before trying again.');
      await recordAdminActionFromRequest(req, {
        action: 'user.tags.updated',
        target: { kind: 'user', id: userId, displayName: userId },
        summary: 'updated account tags',
        changes: [{ field: 'tags', before, after: tags }],
      });
    });
    return res.json({ tags });
  }
);

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
