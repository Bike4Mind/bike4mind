import { IBaseEvent } from '../../../types';

export enum OrganizationEvents {
  ADD_ORG_MEMBER = 'Add Member to Organization',
  REMOVE_ORG_MEMBER = 'Remove Member from Organization',
  LEAVE_ORG = 'Leave Organization',
}

export interface IAddMemberToOrganizationEvent extends IBaseEvent {
  type: OrganizationEvents.ADD_ORG_MEMBER;
  metadata: {
    memberEmail: string;
    memberLevel: string;
    organizationId: string;
  };
}

export interface IRemoveMemberFromOrganizationEvent extends IBaseEvent {
  type: OrganizationEvents.REMOVE_ORG_MEMBER;
  metadata: {
    userId: string;
    organizationId: string;
  };
}

export interface ILeaveOrganizationEvent extends IBaseEvent {
  type: OrganizationEvents.LEAVE_ORG;
  metadata: {
    userId: string;
    organizationId: string;
  };
}

export type OrganizationEventPayload =
  | IAddMemberToOrganizationEvent
  | IRemoveMemberFromOrganizationEvent
  | ILeaveOrganizationEvent;
