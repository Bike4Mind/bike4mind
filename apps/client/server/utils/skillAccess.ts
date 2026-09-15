// apps/client/server/utils/skillAccess.ts
import { organizationRepository } from '@bike4mind/database/infra';
import { ISkill, IUserShare, IGroupShare, Permission } from '@bike4mind/common';

/**
 * Centralized access predicates for a skill, shared by every skill endpoint so
 * the read / edit / delete / share rules can't drift apart. Each predicate
 * layers four sources of authority:
 *
 *   1. super-admin (`isAdmin`) - full access to any skill, including the
 *      org/system-scoped skills they create (without this, a system skill is
 *      orphaned the moment it's created: `userId` is undefined so the creator
 *      fails the owner check and can never GET/edit/delete/share it).
 *   2. owner (`userId === actor.id`) - user-scoped skills.
 *   3. org admin (org owner or manager) - org-scoped skills, so the team that
 *      owns a skill can manage it. Resolved lazily and only for org-scoped
 *      skills, so user-scoped reads never hit the org store.
 *   4. direct user-shares (`users[].permissions`) and the global flags.
 */
export type ShareableSkill = ISkill & {
  users?: IUserShare[];
  groups?: IGroupShare[];
  isGlobalRead?: boolean;
  isGlobalWrite?: boolean;
};

export type SkillActor = { id: string; isAdmin?: boolean };

const hasSharePermission = (skill: ShareableSkill, actorId: string, permission: Permission): boolean =>
  skill.users?.some(u => u.userId === actorId && u.permissions?.includes(permission)) ?? false;

/** Is the actor the owner or manager of the org that owns an org-scoped skill? */
const isOrgAdminFor = async (skill: ShareableSkill, actor: SkillActor): Promise<boolean> => {
  if (!skill.organizationId) return false;
  const org = await organizationRepository.findById(skill.organizationId);
  if (!org) return false;
  return org.userId === actor.id || org.managerId === actor.id;
};

/** View access - owner, admin, org-admin, any direct share, or global-read. */
export const canAccessSkill = async (skill: ShareableSkill, actor: SkillActor): Promise<boolean> => {
  if (actor.isAdmin) return true;
  if (skill.userId === actor.id) return true;
  if (skill.users?.some(u => u.userId === actor.id)) return true;
  if (skill.isGlobalRead === true) return true;
  return isOrgAdminFor(skill, actor);
};

/** Edit access - owner, admin, org-admin, a `update` share, or global-write. */
export const canEditSkill = async (skill: ShareableSkill, actor: SkillActor): Promise<boolean> => {
  if (actor.isAdmin) return true;
  if (skill.userId === actor.id) return true;
  if (skill.isGlobalWrite === true) return true;
  if (hasSharePermission(skill, actor.id, Permission.update)) return true;
  return isOrgAdminFor(skill, actor);
};

/**
 * Delete access - owner, admin, org-admin, or a `delete` share. Deletion is
 * destructive, so (unlike edit) it is NOT granted by `isGlobalWrite`.
 */
export const canDeleteSkill = async (skill: ShareableSkill, actor: SkillActor): Promise<boolean> => {
  if (actor.isAdmin) return true;
  if (skill.userId === actor.id) return true;
  if (hasSharePermission(skill, actor.id, Permission.delete)) return true;
  return isOrgAdminFor(skill, actor);
};

/**
 * Share-management access - owner, super-admin, or org-admin ONLY.
 *
 * A bare `share` user-grant does NOT confer management here. Honoring it (the
 * v1 behavior) was a privilege-escalation: the share endpoint persists
 * caller-supplied `isGlobalWrite`/`isGlobalRead` and a full `users[]` roster, so
 * a `share`-only grantee could flip instance-wide global-write or self-grant
 * `update`/`delete`/`share` and gain strictly more authority than their grant.
 * Sub-delegation has no v1 requirement, so management is gated to the principals
 * who already hold full authority over the skill. `Permission.share` remains
 * grantable in the model for a future, properly-scoped delegation feature; it is
 * simply inert today.
 */
export const canManageSkillSharing = async (skill: ShareableSkill, actor: SkillActor): Promise<boolean> => {
  if (actor.isAdmin) return true;
  if (skill.userId === actor.id) return true;
  return isOrgAdminFor(skill, actor);
};

/**
 * Synchronous counterpart of `canManageSkillSharing` for the list endpoint,
 * where the caller's administered-org ids are already resolved in one batch
 * query - so we avoid a per-row `organizationRepository.findById`. Same
 * predicate (owner / super-admin / org-admin), org-admin decided against the
 * precomputed set.
 */
export const canManageSkillSharingWith = (
  skill: ShareableSkill,
  ctx: { actorId: string; isAdmin?: boolean; adminOrganizationIds?: string[] }
): boolean => {
  if (ctx.isAdmin) return true;
  if (skill.userId === ctx.actorId) return true;
  return !!skill.organizationId && (ctx.adminOrganizationIds?.includes(skill.organizationId) ?? false);
};

/**
 * Redact the share roster for a caller who can't manage sharing: keep the
 * caller's OWN `users[]` row (so client-side action gating still works), drop
 * everyone else's rows, and drop all `groups`. A global-read skill is viewable
 * by every signed-in user, so returning the full roster would let any of them
 * enumerate who a skill is shared with. The caller's own row leaks nothing -
 * it's their userId and their own grant.
 */
export const redactShareRosterForViewer = (
  skill: ShareableSkill,
  actorId: string,
  canManageSharing: boolean
): ShareableSkill => {
  if (canManageSharing) return skill;
  const { groups: _groups, ...rest } = skill;
  return { ...rest, users: skill.users?.filter(u => u.userId === actorId) ?? [] };
};
