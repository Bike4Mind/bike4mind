import { IBaseEvent } from '../../../types';

export enum ElabsEvents {
  CREATE_ELABS_VOICE = 'Elabs Voice Created',
  DELETE_ELABS_VOICE = 'Elabs Voice Deleted',
  SET_ACTIVE_ELABS_VOICE = 'Active Elabs Voice Set',
}

interface ICreateElabsVoiceEvent extends IBaseEvent {
  type: ElabsEvents.CREATE_ELABS_VOICE;
  metadata: {
    /** ID of the elabs voice that was created */
    id: string;
  };
}

interface IDeleteElabsVoiceEvent extends IBaseEvent {
  type: ElabsEvents.DELETE_ELABS_VOICE;
  metadata: {
    /** ID of the elabs voice that was deleted */
    id: string;
  };
}

interface ISetActiveElabsVoiceEvent extends IBaseEvent {
  type: ElabsEvents.SET_ACTIVE_ELABS_VOICE;
  metadata: {
    /** ID of the elabs voice that was set as active */
    id: string;
  };
}

export type ElabsEventPayload = ICreateElabsVoiceEvent | IDeleteElabsVoiceEvent | ISetActiveElabsVoiceEvent;
