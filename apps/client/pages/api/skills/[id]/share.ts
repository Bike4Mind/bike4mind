// apps/client/pages/api/skills/[id]/share.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { IUserShare, Permission } from '@bike4mind/common';
import { NotFoundError, ForbiddenError } from '@bike4mind/utils';
import { z } from 'zod';
import { ShareableSkill, canManageSkillSharing } from '@server/utils/skillAccess';

/**
 * Replace the sharing configuration for a skill. PUT semantics: the supplied
 * `users` array (and global toggles) become the new state - the dialog sends
 * the full desired set, so add / remove / change-permission are all expressed
 * as one idempotent write.
 *
 * Each user-share must carry at least one permission. We accept only the
 * permissions meaningful as a per-document grant (read / update / delete /
 * share) - `create` has no per-document semantics, so excluding it keeps a
 * no-op permission from accumulating as dead data on the share.
 */
const shareSchema = z.object({
  users: z
    .array(
      z.object({
        userId: z.string().min(1),
        permissions: z.array(z.enum([Permission.read, Permission.update, Permission.delete, Permission.share])).min(1),
      })
    )
    .optional(),
  isGlobalRead: z.boolean().optional(),
  isGlobalWrite: z.boolean().optional(),
});

const handler = baseApi().put(async (req, res) => {
  const { id } = req.query as { id: string };

  const skill = (await skillRepository.findById(id)) as ShareableSkill | null;
  if (!skill) throw new NotFoundError('Skill not found');

  if (!(await canManageSkillSharing(skill, { id: req.user!.id, isAdmin: req.user!.isAdmin }))) {
    throw new ForbiddenError("You don't have permission to manage sharing for this skill");
  }

  const { users, isGlobalRead, isGlobalWrite } = shareSchema.parse(req.body);

  // Enforce the invariant the UI couples but the API otherwise accepts à la carte:
  // global-write implies global-read. A direct caller sending `isGlobalWrite: true`
  // (with read absent or explicitly false) would otherwise persist a state the UI
  // can never produce - global edit-for-all without global visibility.
  const effectiveGlobalRead = isGlobalWrite === true ? true : isGlobalRead;

  // De-dupe by userId (last write wins) and drop a self-share on the owner -
  // the owner's access is implied by ownership, never by the users array.
  const dedupedUsers =
    users === undefined
      ? undefined
      : Array.from(new Map(users.filter(u => u.userId !== skill.userId).map(u => [u.userId, u])).values());

  const updated = await skillRepository.update(
    {
      id,
      ...(dedupedUsers !== undefined && { users: dedupedUsers as IUserShare[] }),
      ...(effectiveGlobalRead !== undefined && { isGlobalRead: effectiveGlobalRead }),
      ...(isGlobalWrite !== undefined && { isGlobalWrite }),
    },
    { new: true }
  );

  res.json(updated ?? (await skillRepository.findById(id)));
});

export default handler;
