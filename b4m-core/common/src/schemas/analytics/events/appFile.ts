import { IBaseEvent } from '../../../types';

export enum AppFileEvents {
  CREATE_APP_FILE = 'App File Created',
  DELETE_APP_FILE = 'App File Deleted',
  UPDATE_APP_FILE_TAGS = 'App File Tags Updated',
}

interface ICreateAppFileEvent extends IBaseEvent {
  type: AppFileEvents.CREATE_APP_FILE;
  metadata: {
    /** ID of the app file that was created */
    id: string;
  };
}

interface IDeleteAppFileEvent extends IBaseEvent {
  type: AppFileEvents.DELETE_APP_FILE;
  metadata: {
    /** ID of the app file that was deleted */
    id: string;
  };
}

interface IUpdateAppFileTagsEvent extends IBaseEvent {
  type: AppFileEvents.UPDATE_APP_FILE_TAGS;
  metadata: {
    /** ID of the app file whose tags were updated */
    id: string;
    /** New tags for the app file */
    tags: string[];
  };
}

export type AppFileEventPayload = ICreateAppFileEvent | IDeleteAppFileEvent | IUpdateAppFileTagsEvent;
