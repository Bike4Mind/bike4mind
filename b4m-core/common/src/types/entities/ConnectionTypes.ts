import { type IMongoDocument } from '.';
import { type ApiKeyScope } from './UserApiKeyTypes';

export type ConnectionSource = 'cli' | 'web';

export interface IConnection {
  connectionId: string;
  userId: string;
  source?: ConnectionSource;
  /** Scopes of the API key the socket was authenticated with at $connect, if
   *  any. Used by WS action handlers as a cheap defense-in-depth layer so a
   *  narrow-scope key (e.g. CC_BRIDGE) can't silently gain privileges in any
   *  future handler that trusts socket-level auth. JWT-authenticated sockets
   *  leave this unset. */
  scopes?: ApiKeyScope[];
}

export interface IConnectionDocument extends Omit<IConnection, 'userId'>, IMongoDocument {
  userId: string;
}
