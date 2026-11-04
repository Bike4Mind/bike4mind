import { randomUUID } from 'crypto';
import type { IMcpConnectionDocument, McpOAuthTokenUpdate } from '@bike4mind/common';
import { mcpConnectionRepository } from '@bike4mind/database';
import {
  RemoteMcpAuthRequiredError,
  RemoteMcpError,
  RemoteMcpInvalidGrantError,
  RemoteMcpOAuthError,
  RemoteMcpTimeoutError,
  OAUTH_REQUEST_TIMEOUT_MS,
  refreshRemoteMcpTokens,
} from '@bike4mind/mcp/remote';
import { decryptToken, encryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RemoteMcpNetworkOptions } from '../customMcpAccess';
import { dropRejectedRegistration, loadConnectionClient } from './clientIdentity';
import { withOAuthFetch } from './oauthFetch';

/** A token that expires within this window is refreshed before use. */
export const OAUTH_EXPIRY_SKEW_MS = 60_000;
const HELD_POLL_MS = 250;
/** Must stay ordered: OAUTH_REQUEST_TIMEOUT_MS < HELD_POLL_MAX_MS < MCP_REFRESH_LEASE_TTL_MS (database package). */
const HELD_POLL_MAX_MS = OAUTH_REQUEST_TIMEOUT_MS + 2_000;

/**
 * The grant is gone and the user must sign in again. The connection is already stored as
 * `needs_reconnect` with the reason, so `invokeRemoteMcp` does not overwrite it.
 */
export class OAuthReconnectRequiredError extends RemoteMcpAuthRequiredError {
  constructor() {
    super({});
    this.name = 'OAuthReconnectRequiredError';
  }
}

/**
 * The grant was disconnected or replaced while a refresh was in flight, and nothing usable is stored.
 * The new state is already recorded by whoever changed it, so no status is written for this.
 */
export class OAuthGrantSupersededError extends RemoteMcpAuthRequiredError {
  constructor() {
    super({});
    this.name = 'OAuthGrantSupersededError';
  }
}

/**
 * The authorization server (or a refresh already in flight) did not deliver a token in time. A timeout to the
 * caller, but nothing about the grant or the MCP server is known, so no status is recorded for it.
 */
export class OAuthRefreshUnavailableError extends RemoteMcpTimeoutError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OAuthRefreshUnavailableError';
  }
}

export interface AccessTokenOptions {
  network: RemoteMcpNetworkOptions;
  /** Refresh even if the stored token looks valid (the server just rejected it). */
  force?: boolean;
  /**
   * The bearer the server just rejected. A stored token that differs from it is someone else's refresh and is
   * reused; without it the token read with `connection` is the marker, which misses a refresh made after that read.
   */
  rejectedToken?: string;
  /** Called with the encrypted access token that the returned bearer came from, so a failure can be pinned to it. */
  onIssued?: (accessTokenEnc: string | undefined) => void;
  fetchFn?: FetchLike;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Owner = { ownerType: 'user'; ownerKey: string };

type OAuthState = NonNullable<IMcpConnectionDocument['auth']['oauth']>;

const remainingMs = (oauth: OAuthState, now: number): number =>
  oauth.expiresAt ? new Date(oauth.expiresAt).getTime() - now : Infinity;

/** Worth using for a new request without refreshing first. */
const isFresh = (oauth: OAuthState, now: number): boolean =>
  Boolean(oauth.accessTokenEnc) && remainingMs(oauth, now) > OAUTH_EXPIRY_SKEW_MS;

/**
 * A token someone else just stored: any unexpired one, however short its life. The skew only decides when
 * to refresh; applying it here would make a token of 60 s or less look stale to the very caller that got it.
 */
const isUnexpired = (oauth: OAuthState, now: number): boolean =>
  Boolean(oauth.accessTokenEnc) && remainingMs(oauth, now) > 0;

/**
 * The bearer token for an OAuth connection, refreshed lazily. At most one caller refreshes at a time:
 * the winner of `acquireRefreshLease` calls the token endpoint and the others wait for its result, so a
 * rotating refresh token is never presented twice. Returns undefined when there is no grant yet (the
 * caller then sends no credentials and the server's 401 records the challenge). Tokens are never logged.
 */
export async function getOAuthAccessToken(
  connection: IMcpConnectionDocument,
  options: AccessTokenOptions
): Promise<string | undefined> {
  const issued = await resolveAccessToken(connection, options);
  options.onIssued?.(issued?.enc);
  return issued?.token;
}

interface Issued {
  token: string | undefined;
  enc: string | undefined;
}

const issuedFrom = (enc: string | undefined): Issued => ({ token: decryptToken(enc) ?? undefined, enc });

async function resolveAccessToken(
  connection: IMcpConnectionDocument,
  options: AccessTokenOptions
): Promise<Issued | undefined> {
  const oauth = connection.auth.oauth;
  const now = options.now ?? Date.now;
  if (!oauth || (!oauth.accessTokenEnc && !oauth.refreshTokenEnc)) return undefined;
  if (!options.force && isFresh(oauth, now())) return issuedFrom(oauth.accessTokenEnc);
  // An expired access token with nothing to refresh it, or a rejected one that cannot be replaced.
  if (!oauth.refreshTokenEnc) throw new RemoteMcpAuthRequiredError({});

  const owner: Owner = { ownerType: 'user', ownerKey: connection.ownerKey };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const staleAccessTokenEnc = oauth.accessTokenEnc;
  const isStale = (enc: string | undefined) =>
    options.rejectedToken !== undefined ? decryptToken(enc) === options.rejectedToken : enc === staleAccessTokenEnc;
  const deadline = now() + HELD_POLL_MAX_MS;

  for (;;) {
    const holder = randomUUID();
    const lease = await mcpConnectionRepository.acquireRefreshLease(connection.id, owner, holder);
    if (lease.outcome === 'not_found') throw new RemoteMcpAuthRequiredError({});

    if (lease.outcome === 'acquired') {
      const current = lease.connection;
      const currentOauth = current.auth.oauth;
      if (!currentOauth?.refreshTokenEnc) {
        await mcpConnectionRepository.releaseRefreshLease(connection.id, holder);
        throw new RemoteMcpAuthRequiredError({});
      }
      // Someone refreshed between our read and the lease: use theirs instead of spending the refresh token.
      if (!isStale(currentOauth.accessTokenEnc) && isUnexpired(currentOauth, now())) {
        await mcpConnectionRepository.releaseRefreshLease(connection.id, holder);
        return issuedFrom(currentOauth.accessTokenEnc);
      }
      return refreshWithLease(current, owner, holder, options);
    }

    // Held: wait for the holder to finish, then take whatever it stored.
    await sleep(HELD_POLL_MS);
    const latest = await mcpConnectionRepository.findByIdWithCredentials(connection.id, owner);
    const latestOauth = latest?.auth.oauth;
    if (!latest || !latestOauth) throw new RemoteMcpAuthRequiredError({});
    if (latest.status === 'needs_reconnect') throw new OAuthReconnectRequiredError();
    if (!isStale(latestOauth.accessTokenEnc) && isUnexpired(latestOauth, now())) {
      return issuedFrom(latestOauth.accessTokenEnc);
    }
    // A crashed holder's lease outlives this window; a timeout is transient, not a reason to sign in again.
    if (now() >= deadline) throw new OAuthRefreshUnavailableError('Another request is refreshing the sign-in');
  }
}

async function refreshWithLease(
  connection: IMcpConnectionDocument,
  owner: Owner,
  holder: string,
  options: AccessTokenOptions
): Promise<Issued | undefined> {
  const oauth = connection.auth.oauth;
  try {
    const refreshToken = decryptToken(oauth?.refreshTokenEnc);
    const client = oauth && (await loadConnectionClient(connection));
    if (!oauth || !refreshToken || !client || !oauth.tokenEndpoint) throw new RemoteMcpAuthRequiredError({});

    const tokens = await withOAuthFetch(options.network, options.fetchFn, fetchFn =>
      refreshRemoteMcpTokens({ ...oauth, tokenEndpoint: oauth.tokenEndpoint ?? '' }, { client, refreshToken, fetchFn })
    );
    const accessTokenEnc = encryptToken(tokens.accessToken);
    if (!accessTokenEnc) throw new Error('Access token encryption returned nothing');
    // The authorization server has already rotated the refresh token: keeping the old one would strand the grant.
    const refreshTokenEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : undefined;
    if (tokens.refreshToken && !refreshTokenEnc) throw new Error('Refresh token encryption returned nothing');
    const update: McpOAuthTokenUpdate = {
      accessTokenEnc,
      ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
      ...(tokens.expiresInSeconds
        ? { expiresAt: new Date((options.now ?? Date.now)() + tokens.expiresInSeconds * 1000) }
        : {}),
      ...(tokens.scope ? { grantedScope: tokens.scope.slice(0, 1024) } : {}),
    };
    const write = () => mcpConnectionRepository.completeRefresh(connection.id, holder, update);
    let completed: Awaited<ReturnType<typeof write>>;
    try {
      completed = await write();
    } catch {
      try {
        completed = await write();
      } catch {
        // The answer is already spent at the server; this call can still use its token even though it was not stored.
        return { token: tokens.accessToken, enc: accessTokenEnc };
      }
    }
    if (completed) return { token: tokens.accessToken, enc: accessTokenEnc };

    return await tokenAfterLostLease(connection.id, owner, options);
  } catch (error) {
    if (error instanceof RemoteMcpInvalidGrantError) {
      // Only the current holder may say the grant is gone: a late answer must not overwrite what a successor stored.
      const marked = await mcpConnectionRepository.setNeedsReconnectIfHolder(connection.id, holder, {
        code: 'invalid_grant',
        message: 'Your sign-in expired; reconnect to continue',
      });
      if (marked) throw new OAuthReconnectRequiredError();
      return await tokenAfterLostLease(connection.id, owner, options);
    }
    if (error instanceof RemoteMcpOAuthError) {
      if (error.code === 'token_unavailable') {
        throw new OAuthRefreshUnavailableError('The authorization server did not answer', { cause: error });
      }
      await dropRejectedRegistration(connection, error);
      // A definitive refusal other than invalid_grant: same holder guard, so a late answer cannot clobber a successor.
      const marked = await mcpConnectionRepository.setNeedsReconnectIfHolder(connection.id, holder, {
        code: 'auth_failed',
        message: 'The server refused the credentials',
      });
      if (marked) throw new OAuthReconnectRequiredError();
      return await tokenAfterLostLease(connection.id, owner, options);
    }
    if (error instanceof RemoteMcpError) throw error;
    // A network or storage failure: transient, and no reason to ask the user to sign in again.
    throw new OAuthRefreshUnavailableError('The authorization server did not answer', { cause: error });
  } finally {
    // A no-op once completeRefresh cleared it; frees the lease on every failure path.
    await mcpConnectionRepository.releaseRefreshLease(connection.id, holder);
  }
}

/** The lease was lost (it expired, or the user reconnected or disconnected): use what is stored, never write over it. */
async function tokenAfterLostLease(id: string, owner: Owner, options: AccessTokenOptions): Promise<Issued | undefined> {
  const latest = await mcpConnectionRepository.findByIdWithCredentials(id, owner);
  if (latest?.auth.oauth && isUnexpired(latest.auth.oauth, (options.now ?? Date.now)())) {
    return issuedFrom(latest.auth.oauth.accessTokenEnc);
  }
  throw new OAuthGrantSupersededError();
}
