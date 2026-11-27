import { heldPermissions, IProjectDocument, IShareableDocument, IUserRepository, Permission } from '@bike4mind/common';

export type SharedItem = IShareableDocument & { id: string; userId: string };

export const projectParticipants = (project: Pick<IProjectDocument, 'userId' | 'users'>) => [
  project.userId,
  ...(project.users ?? []).map(u => u.userId),
];

// Same read arms as readAccessArms in packages/database SharableDocumentModel.ts.
const READ_PERMISSIONS: readonly string[] = [Permission.read, 'write'];

export type GrantorUsers = Pick<IUserRepository, 'findById' | 'findUserIdsByGroupIds'>;

export const projectAccessRecipients = async (
  project: Pick<IProjectDocument, 'userId' | 'users' | 'groups'>,
  users: Pick<IUserRepository, 'findUserIdsByGroupIds'>
) => {
  const groupIds = (project.groups ?? [])
    .filter(group => group.permissions?.some(permission => READ_PERMISSIONS.includes(permission)))
    .map(group => group.groupId);
  const members = groupIds.length ? Object.values(await users.findUserIdsByGroupIds(groupIds)).flat() : [];
  return [...new Set([...projectParticipants(project).map(String), ...members])];
};

/**
 * Builds a check for whether some participant of `project` can still grant an item there: the
 * item's owner takes part, or a participant holds share on it through an untagged row or a group.
 * Rows tagged with a project or session were minted by that path, so they are not a grantor's own
 * share. Members of groups the project is shared with take part too. Same rule as grantCap on
 * attach (projectService/addFiles.ts); shared by revoke (detach) and acceptProject (pass on).
 * Participants and their groups are loaded at most once per check, and only when needed.
 */
export const projectGrantorCheck = (
  project: Pick<IProjectDocument, 'userId' | 'users' | 'groups'>,
  db: { users: GrantorUsers }
) => {
  let participantIds: Promise<string[]> | undefined;
  let participantUsers: Promise<{ id: string; groups: string[] }[]> | undefined;

  const loadIds = () =>
    (participantIds ??= (async () => {
      const ids = new Set(projectParticipants(project).map(String));
      const groupIds = (project.groups ?? [])
        .filter(group => group.permissions?.some(p => READ_PERMISSIONS.includes(p)))
        .map(group => group.groupId);
      if (groupIds.length > 0) {
        const membersByGroup = await db.users.findUserIdsByGroupIds(groupIds);
        for (const members of Object.values(membersByGroup)) members.forEach(id => ids.add(id));
      }
      return [...ids];
    })());
  const loadUsers = () =>
    (participantUsers ??= (async () => {
      const users = await Promise.all((await loadIds()).map(id => db.users.findById(id)));
      return users.flatMap(user => (user ? [{ id: user.id, groups: user.groups ?? [] }] : []));
    })());

  return async (item: SharedItem): Promise<boolean> => {
    const ids = await loadIds();
    if (ids.includes(String(item.userId))) return true;
    const ownShares = {
      userId: item.userId,
      users: (item.users ?? []).filter(u => !u.projectId && !u.sessionId),
      groups: item.groups ?? [],
    };
    const holdsShare = (id: string, groups: string[] = []) =>
      heldPermissions(ownShares, id, groups).has(Permission.share);
    if (ids.some(id => holdsShare(id))) return true;
    if (ownShares.groups.length === 0) return false;
    return (await loadUsers()).some(user => holdsShare(user.id, user.groups));
  };
};
