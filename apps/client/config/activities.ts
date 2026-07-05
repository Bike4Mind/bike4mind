import PersonAddIcon from '@mui/icons-material/PersonAdd';
import PeopleIcon from '@mui/icons-material/People';
import PersonRemoveIcon from '@mui/icons-material/PersonRemove';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import DeleteIcon from '@mui/icons-material/DeleteSweep';
import { ActivityConfigMap } from '@bike4mind/common';

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

export const ACTIVITY_CONFIG: ActivityConfigMap<typeof PersonAddIcon> = {
  [ActivityType.FRIEND_REQUESTED]: {
    key: ActivityType.FRIEND_REQUESTED,
    icon: PersonAddIcon,
    message: '{performer} sent a friend request to {receiver}',
  },
  [ActivityType.FRIEND_ACCEPTED]: {
    key: ActivityType.FRIEND_ACCEPTED,
    icon: PeopleIcon,
    message: "{performer} accepted {receiver}'s friend request",
  },
  [ActivityType.FRIEND_DECLINED]: {
    key: ActivityType.FRIEND_DECLINED,
    icon: PersonRemoveIcon,
    message: "{performer} declined {receiver}'s friend request",
  },
  [ActivityType.FRIEND_REMOVED]: {
    key: ActivityType.FRIEND_REMOVED,
    icon: PersonRemoveIcon,
    message: '{performer} removed {receiver} from friends',
  },
  [ActivityType.PROJECT_INVITED]: {
    key: ActivityType.PROJECT_INVITED,
    icon: GroupAddIcon,
    message: '{performer} invited {receiver} to {trackable} project',
  },
  [ActivityType.PROJECT_JOINED]: {
    key: ActivityType.PROJECT_JOINED,
    icon: GroupAddIcon,
    message: '{performer} joined project {trackable}',
  },
  [ActivityType.PROJECT_LEAVED]: {
    key: ActivityType.PROJECT_LEAVED,
    icon: PersonRemoveIcon,
    message: '{performer} left project {trackable}',
  },
  [ActivityType.NOTEBOOK_ADDED_TO_PROJECT]: {
    key: ActivityType.NOTEBOOK_ADDED_TO_PROJECT,
    icon: NoteAddIcon,
    message: '{performer} added a notebook to project {trackable}',
  },
  [ActivityType.NOTEBOOK_REMOVED_FROM_PROJECT]: {
    key: ActivityType.NOTEBOOK_REMOVED_FROM_PROJECT,
    icon: DeleteIcon,
    message: '{performer} removed a notebook from {trackable}',
  },
};
