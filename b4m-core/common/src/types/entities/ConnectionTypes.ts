import { type IMongoDocument } from '.';
import { ApiKeyScope, type ApiKeyScopeValue, CONFINED_API_KEY_SCOPES } from './UserApiKeyTypes';

export type ConnectionSource = 'cli' | 'web';

export interface IConnection {
  connectionId: string;
  userId: string;
  handoffPlatform?: 'web' | 'desktop';
  handoffName?: string;
  handoffClientId?: string;
  source?: ConnectionSource;
  /** Scopes of the API key the socket was authenticated with at $connect, if
   *  any. Used by WS action handlers as a cheap defense-in-depth layer so a
   *  narrow-scope key (e.g. CC_BRIDGE) can't silently gain privileges in any
   *  future handler that trusts socket-level auth. JWT-authenticated sockets
   *  leave this unset. */
  scopes?: ApiKeyScopeValue[];
  /** AuthSession the socket belongs to (web ticket or CLI JWT). Absent for API-key sockets and
   *  legacy sid-less tokens. Revoking that session ends the connection. */
  sid?: string;
  /** The user's tokenVersion the socket was authenticated with. Absent for API-key sockets. */
  tokenVersion?: number;
  /** When the credential behind the socket lapses: the access token's exp for web sockets (moved
   *  forward by reauth_connection), connect time + the gateway's 2h cap for API-key and CLI JWT
   *  sockets (neither reauths). */
  authExpiresAt?: Date;
  /** UserApiKey id for API-key sockets; revoking the key ends the connection. */
  apiKeyId?: string;
  /** Set when the connection was ended (revoked, expired, or refused) but its socket has not yet
   *  been confirmed closed. An ended row is not a live connection: reads ignore it, it holds no
   *  subscribers, and the realtime sweep deletes it once the gateway socket is closed. */
  endedAt?: Date;
  /** When reauth_connection last re-stamped the row. Subscriber entries older than this were made
   *  under the previous token, and the sweep drops them. */
  reauthAt?: Date;
}

/** Key scopes whose socket receives the user's own pushes: chat streams, notifications, Keep commands. */
export const USER_FANOUT_API_KEY_SCOPES: readonly ApiKeyScopeValue[] = [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE];

/**
 * Whether a socket gets the frames fanned out to every connection of its user (sendToClient in
 * packages/server-utils/src/websocket/utils.ts and ClientMessageSender in b4m-core/utils). A JWT
 * socket records no scopes and always does; an API-key socket does only when its key holds one of
 * {@link USER_FANOUT_API_KEY_SCOPES} and no confined scope. Frames meant for one socket go through
 * sendToConnection and are unaffected.
 */
export function receivesUserFanout(connection: Pick<IConnection, 'scopes'>): boolean {
  const held = connection.scopes;
  if (!held?.length) return true;
  if (held.some(scope => (CONFINED_API_KEY_SCOPES as readonly ApiKeyScopeValue[]).includes(scope))) return false;
  return USER_FANOUT_API_KEY_SCOPES.some(scope => held.includes(scope));
}

export interface IConnectionDocument extends Omit<IConnection, 'userId'>, IMongoDocument {
  userId: string;
}

/**
 * Which realtime connections to end. `sid` is globally unique, so it needs no userId.
 * `exceptSid` keeps the named session's connections and ends the rest of the user's.
 * `sessionsOnly` spares API-key connections: a session revoke or tokenVersion bump does not
 * touch API keys, so it does not end their sockets either.
 */
export type RealtimeConnectionFilter =
  | { userId: string; exceptSid?: string; sessionsOnly?: boolean }
  | { sid: string }
  | { apiKeyId: string }
  | { connectionIds: string[] };

export interface EndRealtimeConnectionsResult {
  /** Connection ids that were ended: their rows are marked ended (not deleted) and their
   *  subscribers pulled. The realtime sweep closes the sockets and then deletes the rows. */
  connectionIds: string[];
}

/**
 * DB-only lifecycle for realtime (WebSocket) connections: the Connection rows and their
 * QuerySubscription subscriber entries. `endConnections` pulls a connection's subscribers and
 * marks its row ended (`endedAt`); it needs no WebSocket management permission, so any revoke
 * path can call it. The row is kept so the realtime sweep can still find the connection, close its
 * socket through the management API, and delete the row only once the close succeeded (or the
 * socket is already gone). Reads of Connection rows ignore ended rows.
 */
export interface IRealtimeConnectionRepository {
  endConnections: (filter: RealtimeConnectionFilter) => Promise<EndRealtimeConnectionsResult>;
}
