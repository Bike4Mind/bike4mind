import { IBaseEvent } from '../../../types';

export enum SessionEvents {
  CREATE_SESSION = 'Session Created',
  UPDATE_SESSION = 'Session Updated',
  DELETE_SESSION = 'Session Deleted',
  DELETE_ALL_SESSIONS = 'All Sessions Deleted',
  CLONE_SESSION = 'Notebook Cloned',
}

export interface ISessionCreatedEvent extends IBaseEvent {
  type: SessionEvents.CREATE_SESSION;
  metadata: {
    /** ID of the session that was created */
    sessionId: string;
    /** Given name of the session */
    sessionName: string;
    /** Knowledge IDs associated with the session upon creation */
    knowledgeIds: string[];
    /** Agent IDs associated with the session upon creation */
    agentIds: string[];
  };
}

export interface ISessionUpdatedEvent extends IBaseEvent {
  type: SessionEvents.UPDATE_SESSION;
  metadata: {
    /** ID of the session that was updated */
    sessionId: string;
    /** Updated name of the session */
    sessionName: string;
    /** Updated knowledge IDs associated with the session */
    knowledgeIds: string[];
    /** Updated agent IDs associated with the session */
    agentIds: string[];
  };
}

interface ISessionDeletedEvent extends IBaseEvent {
  type: SessionEvents.DELETE_SESSION;
  metadata: {
    /** ID of the session that was deleted */
    sessionId: string;
  };
}

interface IDeleteAllSessionsEvent extends IBaseEvent {
  type: SessionEvents.DELETE_ALL_SESSIONS;
  metadata: {
    /** Number of sessions deleted */
    sessionCount: number;
  };
}

export interface ISessionClonedEvent extends IBaseEvent {
  type: SessionEvents.CLONE_SESSION;
  metadata: {
    /** ID of the session that was cloned */
    sessionId: string;
    /** ID of the new session that was created */
    newSessionId: string;
    /** Name of the new session that was created */
    sessionName: string;
    /** Knowledge IDs associated with the new session */
    knowledgeIds: string[];
    /** Agent IDs associated with the new session */
    agentIds: string[];
  };
}

export type SessionEventPayload =
  | ISessionCreatedEvent
  | ISessionDeletedEvent
  | IDeleteAllSessionsEvent
  | ISessionUpdatedEvent
  | ISessionClonedEvent;
