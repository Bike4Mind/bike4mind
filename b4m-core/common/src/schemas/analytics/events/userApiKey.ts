import { IBaseEvent } from '../../..';

export enum UserApiKeyEvents {
  CREATED = 'User API Key Created',
  USED = 'User API Key Used',
  ROTATED = 'User API Key Rotated',
  REVOKED = 'User API Key Revoked',
  RATE_LIMITED = 'User API Key Rate Limited',
  EXPIRED = 'User API Key Expired',
  DELETED = 'User API Key Deleted',
}

export interface IUserApiKeyCreatedEvent extends IBaseEvent {
  type: UserApiKeyEvents.CREATED;
  metadata: {
    keyId: string;
    name: string;
    scopes: string[];
    expiresAt?: string;
    createdFrom: 'dashboard' | 'cli' | 'api' | 'bridge';
  };
}

export interface IUserApiKeyUsedEvent extends IBaseEvent {
  type: UserApiKeyEvents.USED;
  metadata: {
    keyId: string;
    keyPrefix: string;
    endpoint: string;
    method: string;
    responseTime: number;
    statusCode: number;
    // Optional completions-specific fields
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    stream?: boolean;
    /** Correlation ID echoed as the X-Request-ID header */
    requestId?: string;
  };
}

export interface IUserApiKeyRotatedEvent extends IBaseEvent {
  type: UserApiKeyEvents.ROTATED;
  metadata: {
    keyId: string;
    name: string;
  };
}

export interface IUserApiKeyRevokedEvent extends IBaseEvent {
  type: UserApiKeyEvents.REVOKED;
  metadata: {
    keyId: string;
    name: string;
    reason?: string;
  };
}

export interface IUserApiKeyRateLimitedEvent extends IBaseEvent {
  type: UserApiKeyEvents.RATE_LIMITED;
  metadata: {
    keyId: string;
    keyPrefix: string;
    limitType: 'minute' | 'day';
    limit: number;
    endpoint: string;
    method?: string;
    currentCount?: number;
  };
}

export interface IUserApiKeyExpiredEvent extends IBaseEvent {
  type: UserApiKeyEvents.EXPIRED;
  metadata: {
    keyId: string;
    name: string;
    expiresAt: string;
  };
}

export interface IUserApiKeyDeletedEvent extends IBaseEvent {
  type: UserApiKeyEvents.DELETED;
  metadata: {
    keyId: string;
    name: string;
  };
}

export type UserApiKeyEventPayload =
  | IUserApiKeyCreatedEvent
  | IUserApiKeyUsedEvent
  | IUserApiKeyRotatedEvent
  | IUserApiKeyRevokedEvent
  | IUserApiKeyRateLimitedEvent
  | IUserApiKeyExpiredEvent
  | IUserApiKeyDeletedEvent;
