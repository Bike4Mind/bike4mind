import { heldPermissions, IProjectDocument, IShareableDocument, IUserShare, Permission } from '@bike4mind/common';

export type SharedItem = IShareableDocument & { id: string; userId: string };

export const projectParticipants = (project: Pick<IProjectDocument, 'userId' | 'users'>) => [
  project.userId,
  ...(project.users ?? []).map(u => u.userId),
];

/**
 * Whether some participant of a project can still grant `item` there: the owner takes part, or a
 * participant holds share through `users` (the item's rows outside this project) or a group. Same
 * rule as grantCap on attach (projectService/addFiles.ts). Users are loaded only when no direct row
 * settles it. Shared by revoke (detach) and acceptProject (pass on to a new member).
 */
export const hasGrantorInProject = async (
  item: SharedItem,
  users: IUserShare[],
  participants: string[],
  db: { users: { findById: (id: string) => Promise<{ id: string; groups?: string[] | null } | null> } }
): Promise<boolean> => {
  if (participants.includes(item.userId)) return true;
  const outsideProject = { userId: item.userId, users, groups: item.groups ?? [] };
  const holdsShare = (id: string, groups: string[] = []) =>
    heldPermissions(outsideProject, id, groups).has(Permission.share);
  if (participants.some(id => holdsShare(id))) return true;
  if ((outsideProject.groups ?? []).length === 0) return false;
  const participantUsers = await Promise.all(participants.map(id => db.users.findById(id)));
  return participantUsers.some(user => user && holdsShare(user.id, user.groups ?? []));
};
