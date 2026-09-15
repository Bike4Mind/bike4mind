import { IBaseEvent } from '../../../types';

export enum UiNavigationEvents {
  MORE_CREDITS_CLICKED = 'More Credits Button Clicked',
  SUBSCRIBE_CLICKED = 'Subscribe Button Clicked',
  PROFILE_CLICKED = 'Profile Button Clicked',
  WHATS_NEW_CLICKED = 'Whats New Button Clicked',
}

export interface INavigationEvent extends IBaseEvent {
  type: UiNavigationEvents;
}

export type UiNavigationEventPayload = INavigationEvent;
