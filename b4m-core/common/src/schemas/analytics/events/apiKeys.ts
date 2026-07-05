import { ApiKeyType, IBaseEvent } from '../../../types';

export enum ApiKeyEvents {
  CREATE_API_KEY = 'API Key Created',
  DELETE_API_KEY = 'API Key Deleted',
  SET_API_KEY = 'API Key Set Active',
}

interface ICreateApiKeyEvent extends IBaseEvent {
  type: ApiKeyEvents.CREATE_API_KEY;
  metadata: {
    /** ID of the API key that was created */
    id: string;
    /** Description of the API key */
    description: string;
    /** Whether the API key created was set to active upon creation */
    isActive: boolean;
    /** Type of the API key */
    type: ApiKeyType;
  };
}

interface IDeleteApiKeyEvent extends IBaseEvent {
  type: ApiKeyEvents.DELETE_API_KEY;
  metadata: {
    /** ID of the API key that was deleted */
    id: string;
  };
}

/**
 * Event that is triggered when a user sets an API key as active
 */
interface ISetApiKeyEvent extends IBaseEvent {
  type: ApiKeyEvents.SET_API_KEY;
  metadata: {
    /** ID of the API key that was set */
    id: string;
  };
}

export type ApiKeyEventPayload = ICreateApiKeyEvent | IDeleteApiKeyEvent | ISetApiKeyEvent;
