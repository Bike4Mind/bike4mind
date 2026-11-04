/**
 * OAuth protocol steps for a remote MCP server (RFC 9728 discovery, RFC 8414 / OIDC metadata, RFC 7591
 * registration, PKCE authorization, code exchange, refresh, RFC 7009 revoke). Pure HTTP: no database, no
 * encryption, no policy. Every call takes the `fetchFn` to use, so the app passes the SSRF-pinned fetch and
 * tests pass the loopback-allowed one. The SDK does the wire work; this adds what it does not check:
 * S256 required, https plus the connector URL rules on every endpoint, and the `resource` match.
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { validateRemoteMcpUrl, type ValidateRemoteMcpUrlOptions } from './validateRemoteMcpUrl';

export type RemoteMcpOAuthErrorCode = 'discovery_failed' | 'invalid_grant' | 'token_failed';

/** `code` is stable and safe to show or log; the message never carries a token or a server-supplied string. */
export class RemoteMcpOAuthError extends Error {
  readonly code: RemoteMcpOAuthErrorCode;

  constructor(code: RemoteMcpOAuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteMcpOAuthError';
    this.code = code;
  }
}

/** The grant is gone (revoked, expired, or reused): the user has to sign in again. */
export class RemoteMcpInvalidGrantError extends RemoteMcpOAuthError {
  constructor(options?: { cause?: unknown }) {
    super('invalid_grant', 'The authorization grant is no longer valid', options);
    this.name = 'RemoteMcpInvalidGrantError';
  }
}

export interface RemoteMcpOAuthDiscovery {
  resource: string;
  resourceMetadataUrl?: string;
  issuer: string;
  authorizationServerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  /**
   * RFC 9207: the authorization response carries `iss`. The SDK strips this field from OIDC-style metadata, so
   * it reads false there; a callback that receives an `iss` anyway must still compare it.
   */
  issParameterSupported: boolean;
  /** The server accepts a URL as `client_id` (OAuth Client ID Metadata Document). */
  cimdSupported: boolean;
  scopesSupported: string[];
  tokenEndpointAuthMethodsSupported: string[];
  /** The raw metadata, for the SDK calls that take it; not meant to be stored. */
  metadata: AuthorizationServerMetadata;
}

export interface RemoteMcpOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** `none`, `client_secret_post` or `client_secret_basic`; derived from the secret when absent. */
  tokenEndpointAuthMethod?: string;
}

export interface RemoteMcpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
}

/** What refresh, revoke and registration need from a previous discovery, as the connection stores it. */
export interface RemoteMcpOAuthEndpoints {
  issuer: string;
  authorizationServerUrl: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
}

function fail(message: string, cause?: unknown): never {
  throw new RemoteMcpOAuthError('discovery_failed', message, cause === undefined ? undefined : { cause });
}

/** An endpoint taken from server-supplied metadata must be https and pass the connector URL rules. */
function checkedEndpoint(raw: string | undefined, label: string, network: ValidateRemoteMcpUrlOptions): string {
  if (!raw) fail(`The authorization server did not advertise a ${label}`);
  let url: URL;
  try {
    url = validateRemoteMcpUrl(raw, network);
  } catch (error) {
    return fail(`The authorization server's ${label} is not allowed`, error);
  }
  return url.toString();
}

const stripSlash = (value: string) => value.replace(/\/+$/, '');

/**
 * Finds the authorization server for `serverUrl` and checks it is usable. Tries the 401's
 * `resource_metadata` URL first, then the well-known locations (the SDK walks path-aware then root).
 */
export async function discoverRemoteMcpOAuth(
  serverUrl: string,
  options: { resourceMetadataUrl?: string; fetchFn: FetchLike; network: ValidateRemoteMcpUrlOptions }
): Promise<RemoteMcpOAuthDiscovery> {
  const { fetchFn, network } = options;
  const server = validateRemoteMcpUrl(serverUrl, network);

  let prm: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | undefined;
  let prmUrl: string | undefined;
  for (const candidate of [options.resourceMetadataUrl, undefined]) {
    try {
      if (candidate) validateRemoteMcpUrl(candidate, network);
      prm = await discoverOAuthProtectedResourceMetadata(server, { resourceMetadataUrl: candidate }, fetchFn);
      prmUrl = candidate;
      break;
    } catch (error) {
      if (candidate === undefined) fail('The server does not publish OAuth protected resource metadata', error);
    }
  }
  if (!prm) return fail('The server does not publish OAuth protected resource metadata');

  if (!checkResourceAllowed({ requestedResource: server, configuredResource: prm.resource })) {
    fail('The protected resource metadata names a different resource');
  }
  const asUrl = checkedEndpoint(prm.authorization_servers?.[0], 'authorization server', network);

  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn });
  } catch (error) {
    fail('The authorization server metadata could not be read', error);
  }
  if (!metadata) return fail('The authorization server does not publish metadata');
  if (stripSlash(metadata.issuer) !== stripSlash(asUrl)) fail('The authorization server issuer does not match');
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    fail('The authorization server does not support PKCE with S256');
  }

  const extra = metadata as AuthorizationServerMetadata & {
    authorization_response_iss_parameter_supported?: boolean;
    client_id_metadata_document_supported?: boolean;
    revocation_endpoint?: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  const optional = (value: string | undefined, label: string) =>
    value ? checkedEndpoint(value, label, network) : undefined;
  return {
    resource: prm.resource,
    resourceMetadataUrl: prmUrl,
    issuer: metadata.issuer,
    authorizationServerUrl: asUrl,
    authorizationEndpoint: checkedEndpoint(metadata.authorization_endpoint, 'authorization endpoint', network),
    tokenEndpoint: checkedEndpoint(metadata.token_endpoint, 'token endpoint', network),
    revocationEndpoint: optional(extra.revocation_endpoint, 'revocation endpoint'),
    registrationEndpoint: optional(extra.registration_endpoint, 'registration endpoint'),
    issParameterSupported: extra.authorization_response_iss_parameter_supported === true,
    cimdSupported: extra.client_id_metadata_document_supported === true,
    scopesSupported: Array.isArray(extra.scopes_supported)
      ? extra.scopes_supported.filter(s => typeof s === 'string')
      : [],
    tokenEndpointAuthMethodsSupported: extra.token_endpoint_auth_methods_supported ?? [],
    metadata,
  };
}

/**
 * Metadata rebuilt from stored endpoints, for the SDK calls that need a token endpoint but not a fresh
 * discovery. `authorization_endpoint` is never used by them; it is set to the token endpoint to satisfy the type.
 */
function metadataFromEndpoints(endpoints: RemoteMcpOAuthEndpoints): AuthorizationServerMetadata {
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.tokenEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    registration_endpoint: endpoints.registrationEndpoint,
    revocation_endpoint: endpoints.revocationEndpoint,
    response_types_supported: ['code'],
  } as AuthorizationServerMetadata;
}

function clientInformation(client: RemoteMcpOAuthClient): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    token_endpoint_auth_method: client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_post' : 'none'),
  };
}

/** RFC 7591 dynamic registration of a public or confidential client for one redirect URI. */
export async function registerRemoteMcpClient(
  discovery: Pick<RemoteMcpOAuthDiscovery, 'authorizationServerUrl' | 'metadata'>,
  options: { redirectUri: string; clientName: string; scope?: string; fetchFn: FetchLike }
): Promise<RemoteMcpOAuthClient & { clientSecretExpiresAt?: Date; tokenEndpointAuthMethod: string }> {
  try {
    const info = await registerClient(discovery.authorizationServerUrl, {
      metadata: discovery.metadata,
      clientMetadata: {
        redirect_uris: [options.redirectUri],
        client_name: options.clientName,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      scope: options.scope,
      fetchFn: options.fetchFn,
    });
    return {
      clientId: info.client_id,
      clientSecret: info.client_secret,
      tokenEndpointAuthMethod: info.token_endpoint_auth_method ?? (info.client_secret ? 'client_secret_post' : 'none'),
      clientSecretExpiresAt: info.client_secret_expires_at ? new Date(info.client_secret_expires_at * 1000) : undefined,
    };
  } catch (error) {
    return fail('Client registration was refused', error);
  }
}

/** The authorization URL (PKCE S256, `resource`, scope, state) and the verifier to keep for the exchange. */
export async function buildRemoteMcpAuthorizationUrl(
  discovery: Pick<RemoteMcpOAuthDiscovery, 'authorizationServerUrl' | 'metadata' | 'resource'>,
  options: { client: RemoteMcpOAuthClient; redirectUri: string; state: string; scopes: string[] }
): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.metadata,
    clientInformation: clientInformation(options.client),
    redirectUrl: options.redirectUri,
    scope: options.scopes.length > 0 ? options.scopes.join(' ') : undefined,
    state: options.state,
    resource: discovery.resource,
  });
  return { authorizationUrl: authorizationUrl.toString(), codeVerifier };
}

function normalizeTokens(tokens: {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): RemoteMcpOAuthTokens {
  if (tokens.token_type.toLowerCase() !== 'bearer') {
    throw new RemoteMcpOAuthError('token_failed', 'The authorization server issued a token that is not a bearer token');
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresInSeconds: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
    scope: tokens.scope,
  };
}

/** Maps an SDK token-endpoint failure to a typed error; the server's own text is not carried over. */
function tokenFailure(error: unknown): never {
  if (error instanceof RemoteMcpOAuthError) throw error;
  if ((error as { errorCode?: string } | undefined)?.errorCode === 'invalid_grant') {
    throw new RemoteMcpInvalidGrantError({ cause: error });
  }
  throw new RemoteMcpOAuthError('token_failed', 'The authorization server refused the token request', { cause: error });
}

export async function exchangeRemoteMcpCode(
  endpoints: RemoteMcpOAuthEndpoints & { resource: string },
  options: { client: RemoteMcpOAuthClient; code: string; codeVerifier: string; redirectUri: string; fetchFn: FetchLike }
): Promise<RemoteMcpOAuthTokens> {
  try {
    return normalizeTokens(
      await exchangeAuthorization(endpoints.authorizationServerUrl, {
        metadata: metadataFromEndpoints(endpoints),
        clientInformation: clientInformation(options.client),
        authorizationCode: options.code,
        codeVerifier: options.codeVerifier,
        redirectUri: options.redirectUri,
        resource: endpoints.resource,
        fetchFn: options.fetchFn,
      })
    );
  } catch (error) {
    return tokenFailure(error);
  }
}

/** The SDK keeps the old refresh token when the server does not rotate it; callers can rely on that. */
export async function refreshRemoteMcpTokens(
  endpoints: RemoteMcpOAuthEndpoints & { resource: string },
  options: { client: RemoteMcpOAuthClient; refreshToken: string; fetchFn: FetchLike }
): Promise<RemoteMcpOAuthTokens> {
  try {
    return normalizeTokens(
      await refreshAuthorization(endpoints.authorizationServerUrl, {
        metadata: metadataFromEndpoints(endpoints),
        clientInformation: clientInformation(options.client),
        refreshToken: options.refreshToken,
        resource: endpoints.resource,
        fetchFn: options.fetchFn,
      })
    );
  } catch (error) {
    return tokenFailure(error);
  }
}

/** RFC 7009. Throws on a non-2xx answer; the caller decides that a failed revoke is only logged. */
export async function revokeRemoteMcpToken(
  revocationEndpoint: string,
  options: { token: string; hint: 'access_token' | 'refresh_token'; client: RemoteMcpOAuthClient; fetchFn: FetchLike }
): Promise<void> {
  const { client } = options;
  const body = new URLSearchParams({ token: options.token, token_type_hint: options.hint });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret && client.tokenEndpointAuthMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
  }
  const response = await options.fetchFn(revocationEndpoint, { method: 'POST', headers, body });
  await response.body?.cancel();
  if (!response.ok)
    throw new RemoteMcpOAuthError('token_failed', `The revocation endpoint answered HTTP ${response.status}`);
}
