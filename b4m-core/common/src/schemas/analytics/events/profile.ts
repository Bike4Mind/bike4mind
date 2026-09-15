import { IBaseEvent } from '../../../types';

export enum ProfileEvents {
  PROFILE_VIEW = 'Profile Viewed',
}

interface IProfileViewEvent extends IBaseEvent {
  type: ProfileEvents.PROFILE_VIEW;
  metadata: {
    /** ID of the profile that was viewed */
    viewedProfileId: string;
    /** ID of the user who viewed the profile */
    viewerId: string;
  };
}

export type ProfileEventPayload = IProfileViewEvent;
