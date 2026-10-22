// Kept free of UI imports so server code can use the enum; the icon map lives in ./activities.
export enum ActivityType {
  FRIEND_REQUESTED = 'friend.requested',
  FRIEND_ACCEPTED = 'friend.accepted',
  FRIEND_DECLINED = 'friend.declined',
  FRIEND_REMOVED = 'friend.removed',
  PROJECT_INVITED = 'project.invited',
  PROJECT_JOINED = 'project.joined',
  PROJECT_LEAVED = 'project.leaved',
  NOTEBOOK_CREATED = 'notebook.created',
  NOTEBOOK_DELETED = 'notebook.deleted',
  FILE_CREATED = 'file.created',
  NOTEBOOK_ADDED_TO_PROJECT = 'notebook.added.to.project',
  NOTEBOOK_REMOVED_FROM_PROJECT = 'notebook.removed.from.project',
}
