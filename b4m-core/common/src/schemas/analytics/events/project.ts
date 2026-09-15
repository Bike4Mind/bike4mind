import { IBaseEvent } from '../../../types/analytics';

export enum ProjectEvents {
  // Project Management
  CREATE_PROJECT = 'Project Created',
  UPDATE_PROJECT = 'Project Updated',
  DELETE_PROJECT = 'Project Deleted',
  VIEW_PROJECT = 'Project Viewed',

  // Project Content
  ADD_SESSION = 'Session Added to Project',
  REMOVE_SESSION = 'Session Removed from Project',
  ADD_FILE = 'File Added to Project',
  REMOVE_FILE = 'File Removed from Project',
  ADD_SYSTEM_PROMPT = 'System Prompt Added to Project',
  REMOVE_SYSTEM_PROMPT = 'System Prompt Removed from Project',

  // Project Collaboration
  ADD_MEMBER = 'Member Added to Project',
  REMOVE_MEMBER = 'Member Removed from Project',
  UPDATE_MEMBER_ROLE = 'Member Role Updated',
  ADD_GROUP = 'Group Added to Project',
  REMOVE_GROUP = 'Group Removed from Project',
  UPDATE_GROUP_ROLE = 'Group Role Updated',
  PROJECT_JOINED = 'User Joined Project',
  PROJECT_LEAVED = 'User Left Project',

  // Project Settings
  UPDATE_SHARING = 'Project Sharing Updated',
}

export interface IProjectCreatedEvent extends IBaseEvent {
  type: ProjectEvents.CREATE_PROJECT;
  metadata: {
    projectId: string;
    projectName: string;
  };
}

export interface IProjectUpdatedEvent extends IBaseEvent {
  type: ProjectEvents.UPDATE_PROJECT;
  metadata: {
    projectId: string;
    projectName: string;
    updatedFields: string[];
  };
}

export interface IProjectDeletedEvent extends IBaseEvent {
  type: ProjectEvents.DELETE_PROJECT;
  metadata: {
    projectId: string;
    projectName: string;
  };
}

export interface IProjectViewedEvent extends IBaseEvent {
  type: ProjectEvents.VIEW_PROJECT;
  metadata: {
    projectId: string;
    projectName: string;
  };
}

export interface IProjectContentEvent extends IBaseEvent {
  type: ProjectEvents.ADD_SESSION | ProjectEvents.REMOVE_SESSION | ProjectEvents.ADD_FILE | ProjectEvents.REMOVE_FILE;
  metadata: {
    projectId: string;
    projectName: string;
    contentId: string;
    contentType: 'session' | 'file';
  };
}

export interface IProjectSystemPromptEvent extends IBaseEvent {
  type: ProjectEvents.ADD_SYSTEM_PROMPT | ProjectEvents.REMOVE_SYSTEM_PROMPT;
  metadata: {
    projectId: string;
    projectName: string;
    promptId: string;
  };
}

export interface IProjectMemberEvent extends IBaseEvent {
  type: ProjectEvents.ADD_MEMBER | ProjectEvents.REMOVE_MEMBER | ProjectEvents.UPDATE_MEMBER_ROLE;
  metadata: {
    projectId: string;
    projectName: string;
    memberId: string;
    memberRole?: string;
  };
}

export interface IProjectGroupEvent extends IBaseEvent {
  type: ProjectEvents.ADD_GROUP | ProjectEvents.REMOVE_GROUP | ProjectEvents.UPDATE_GROUP_ROLE;
  metadata: {
    projectId: string;
    projectName: string;
    groupId: string;
    groupRole?: string;
  };
}

export interface IProjectSettingsEvent extends IBaseEvent {
  type: ProjectEvents.UPDATE_SHARING;
  metadata: {
    projectId: string;
    projectName: string;
    newValue: boolean;
  };
}

export interface IProjectJoinLeaveEvent extends IBaseEvent {
  type: ProjectEvents.PROJECT_JOINED | ProjectEvents.PROJECT_LEAVED;
  metadata: {
    projectId: string;
    projectName: string;
    memberId: string;
  };
}

export type ProjectEventPayloads =
  | IProjectCreatedEvent
  | IProjectUpdatedEvent
  | IProjectDeletedEvent
  | IProjectViewedEvent
  | IProjectContentEvent
  | IProjectSystemPromptEvent
  | IProjectMemberEvent
  | IProjectGroupEvent
  | IProjectSettingsEvent
  | IProjectJoinLeaveEvent;
