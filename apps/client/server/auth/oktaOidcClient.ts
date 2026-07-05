/**
 * Okta OIDC Client Utility
 *
 * Provides OpenID Connect client functionality for Okta authentication
 * using the openid-client library with native PKCE support.
 *
 * Features:
 * - OIDC issuer discovery with caching
 * - PKCE (Proof Key for Code Exchange) per RFC 7636/9700
 * - Support for both database IDP config and SST secrets fallback
 * - Configurable authorization server ID
 *
 * @see https://datatracker.ietf.org/doc/rfc7636/
 * @see https://datatracker.ietf.org/doc/rfc9700/
 */
import * as client from 'openid-client';
import { isPlaceholderValue } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { identityProviderRepository, IIdentityProviderDocument } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { LOG_URL_TRUNCATE_LENGTH } from './oktaConstants';

/**
 * Okta configuration from database or SST secrets
 */
export interface OktaConfig {
  /** Okta domain URL (e.g., https://your-domain.okta.com) */
  audience: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Authorization server ID (default: 'default') */
  authServerId?: string;
  /** If true, use org-level authorization server (no /oauth2/ path) */
  useOrgAuthServer?: boolean;
}

/**
 * Result of resolving Okta configuration
 */
export interface OktaConfigResult {
  config: OktaConfig | null;
  source: 'database' | 'sst' | null;
  idp?: IIdentityProviderDocument;
}

/**
 * PKCE parameters for authorization flow
 */
export interface PkceParams {
  codeVerifier: string;
  codeChallenge: string;
}

// Cache for OIDC configurations to avoid repeated discovery calls
const configurationCache = new Map<string, { config: client.Configuration; timestamp: number }>();

// Audiences (keyed by `${audience}:${clientId}`) whose custom auth-server
// discovery failed with the documented misconfiguration signal but recovered
// via the org-level server. Once learned, subsequent lookups skip the doomed
// custom discovery and go straight to org-level - eliminating the per-cache-miss
// failed-discovery latency tax and the recurring error-log flood.
//
// This is the in-memory counterpart to the DB self-heal below: DB-backed IDPs
// persist `useOrgAuthServer: true` to Mongo, but SST-sourced configs (immutable
// at runtime) and the window before persistence had no relief and re-failed on
// every cache miss. Process-local by design - it re-learns within a single
// request after a cold start.
const orgLevelDemotedAudiences = new Set<string>();

/**
 * Strip trailing slashes from an Okta audience URL. Discovery already
 * normalizes this way (see getIssuerUrl), so cache and demotion keys must too -
 * otherwise `https://foo.okta.com` and `https://foo.okta.com/` split state for
 * the same issuer (duplicate cache entries, missed demotions).
 */
function normalizeAudience(audience: string): string {
  return audience.replace(/\/+$/, '');
}

/** Key identifying an Okta config for org-level demotion tracking. */
function demotionKey(oktaConfig: OktaConfig): string {
  return `${normalizeAudience(oktaConfig.audience)}:${oktaConfig.clientId}`;
}

// Cache TTL bounds (in seconds)
const MIN_CACHE_TTL_SECONDS = 60; // 1 minute minimum
const MAX_CACHE_TTL_SECONDS = 3600; // 1 hour maximum
const DEFAULT_CACHE_TTL_SECONDS = 300; // 5 minutes default

/**
 * Parse and validate cache TTL from environment variable.
 * Enforces bounds to prevent misconfiguration (too short = DoS on Okta, too long = stale config).
 */
function getCacheTtlMs(): number {
  const envValue = parseInt(process.env.OKTA_OIDC_CACHE_TTL_SECONDS || '', 10);

  if (isNaN(envValue) || envValue <= 0) {
    return DEFAULT_CACHE_TTL_SECONDS * 1000;
  }

  if (envValue < MIN_CACHE_TTL_SECONDS) {
    Logger.warn(
      `[OktaOidc] OKTA_OIDC_CACHE_TTL_SECONDS (${envValue}s) below minimum (${MIN_CACHE_TTL_SECONDS}s), using minimum`
    );
    return MIN_CACHE_TTL_SECONDS * 1000;
  }

  if (envValue > MAX_CACHE_TTL_SECONDS) {
    Logger.warn(
      `[OktaOidc] OKTA_OIDC_CACHE_TTL_SECONDS (${envValue}s) above maximum (${MAX_CACHE_TTL_SECONDS}s), using maximum`
    );
    return MAX_CACHE_TTL_SECONDS * 1000;
  }

  return envValue * 1000;
}

const CACHE_TTL_MS = getCacheTtlMs();

/**
 * Get the issuer URL for an Okta authorization server.
 *
 * Supports two types of authorization servers:
 * - Org-level: Uses base domain as issuer (e.g., https://company.okta.com)
 * - Custom: Uses /oauth2/{authServerId} path (e.g., https://company.okta.com/oauth2/default)
 *
 * @param audience - Okta domain URL
 * @param authServerId - Authorization server ID (only used for custom servers)
 * @param useOrgAuthServer - If true, use org-level server (no /oauth2/ path)
 */
function getIssuerUrl(audience: string, authServerId?: string, useOrgAuthServer?: boolean): URL {
  // Validate HTTPS protocol (defense-in-depth)
  if (!audience.startsWith('https://')) {
    throw new Error('Okta audience must be an HTTPS URL');
  }

  // Normalize audience URL (remove trailing slashes)
  const normalizedAudience = normalizeAudience(audience);

  if (useOrgAuthServer) {
    // Org authorization server: issuer is the base domain
    return new URL(normalizedAudience);
  }

  // Custom authorization server: append /oauth2/{authServerId}
  const serverId = authServerId?.trim() || 'default';

  // Validate authServerId format (defense-in-depth against path traversal)
  if (serverId !== 'default' && !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
    throw new Error('Invalid authorization server ID format');
  }

  return new URL(`${normalizedAudience}/oauth2/${serverId}`);
}

// Error code emitted by openid-client when the discovery endpoint returns a
// non-2xx HTTP status. Mirrored from oauth4webapi (not re-exported by
// openid-client v6). The accompanying `cause` is the original fetch Response.
const RESPONSE_IS_NOT_CONFORM_CODE = 'OAUTH_RESPONSE_IS_NOT_CONFORM';

/**
 * True when a discovery error looks like the documented misconfiguration
 * (wrong auth server URL -> 4xx from the well-known endpoint), and is therefore
 * safe to recover from by retrying against the org-level server.
 *
 * Deliberately excludes 5xx, network failures (TypeError), and ClientErrors
 * with no Response cause. Those indicate Okta-side outages or transport
 * problems where a silent retry-and-persist would mask the real issue and
 * could permanently flip a *correctly* configured IDP to org-level if the
 * retry happens to win the race.
 */
function isLikelyMisconfigDiscoveryError(error: unknown): boolean {
  if (!(error instanceof client.ClientError)) return false;
  if (error.code !== RESPONSE_IS_NOT_CONFORM_CODE) return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Response)) return false;
  return cause.status >= 400 && cause.status < 500;
}

/**
 * Get or create an OIDC configuration for the given Okta config.
 * Uses caching to avoid repeated discovery calls.
 *
 * If primary discovery fails for a custom authorization server with a 4xx
 * response (the documented misconfiguration where the Okta tenant has
 * no custom auth server enabled), retry once against the org-level
 * authorization server. On success we self-heal so we don't pay the latency
 * tax of a failed primary discovery on every subsequent cache miss:
 *   - DB-backed IDPs persist `useOrgAuthServer: true` to Mongo (durable).
 *   - All configs (including immutable SST-sourced ones) additionally record
 *     an in-memory demotion so subsequent lookups skip the doomed custom
 *     discovery for the rest of the process.
 *
 * The fallback is intentionally one-directional (custom -> org) AND
 * narrowly-triggered (4xx only). Bidirectional or broadly-triggered fallback
 * would mask legitimate Okta-side outages and could mis-correct a working
 * IDP if a transient 5xx happens to be followed by a successful org-level
 * retry.
 *
 * @param oktaConfig - Okta configuration
 * @param idp - Source IDP document when config originated from the database.
 *              Required for the durable self-heal persistence step; without it
 *              the in-memory demotion still suppresses the per-cache-miss retry
 *              for the current process.
 * @returns OIDC Configuration instance
 */
export async function getOidcConfiguration(
  oktaConfig: OktaConfig,
  idp?: IIdentityProviderDocument | null
): Promise<client.Configuration> {
  const explicitOrgAuthServer = oktaConfig.useOrgAuthServer ?? false;
  // Skip custom discovery if we've already learned this audience only serves the
  // org-level auth server (avoids re-failing on every cache miss for configs we
  // can't persist a correction for - see orgLevelDemotedAudiences).
  const demoted = !explicitOrgAuthServer && orgLevelDemotedAudiences.has(demotionKey(oktaConfig));
  if (demoted) {
    Logger.debug(
      `[OktaOidc] Audience previously demoted to org-level; skipping custom discovery for ${oktaConfig.audience}`
    );
  }
  const useOrgAuthServer = explicitOrgAuthServer || demoted;
  const authServerId = useOrgAuthServer ? undefined : oktaConfig.authServerId || 'default';
  const normalizedAudience = normalizeAudience(oktaConfig.audience);
  const cacheKey = `${normalizedAudience}:${useOrgAuthServer ? 'org' : authServerId}:${oktaConfig.clientId}`;
  const authServerType = useOrgAuthServer ? 'org-level' : `custom (${authServerId})`;

  // Check cache
  const cached = configurationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    Logger.debug(`[OktaOidc] Cache HIT for ${authServerType} auth server, key: ${cacheKey}`);
    return cached.config;
  }

  Logger.debug(`[OktaOidc] Cache MISS for ${authServerType} auth server, key: ${cacheKey}`);

  // Perform discovery
  const issuerUrl = getIssuerUrl(oktaConfig.audience, authServerId, useOrgAuthServer);
  const discoveryUrl = `${issuerUrl.toString()}/.well-known/openid-configuration`;
  Logger.debug(`[OktaOidc] Discovering ${authServerType} auth server at: ${discoveryUrl}`);

  try {
    const config = await client.discovery(
      issuerUrl,
      oktaConfig.clientId,
      {
        client_secret: oktaConfig.clientSecret,
      },
      client.ClientSecretPost(oktaConfig.clientSecret)
    );

    // Cache the configuration
    configurationCache.set(cacheKey, { config, timestamp: Date.now() });
    Logger.debug(`[OktaOidc] Configuration cached for ${authServerType} auth server, key: ${cacheKey}`);

    return config;
  } catch (error) {
    Logger.error(`[OktaOidc] Discovery failed for ${authServerType} auth server at: ${discoveryUrl}`, error);

    // Only attempt the org-level fallback when this is the documented
    // misconfiguration signal (4xx from the discovery endpoint). Bail on
    // org-level configs (no further fallback to attempt) and on transient
    // errors (5xx, network) where a silent recovery would mask the real cause.
    if (useOrgAuthServer || !isLikelyMisconfigDiscoveryError(error)) {
      throw error;
    }

    const idpHint = idp?.id ? `idp ${idp.id}` : 'SST-fallback config';
    Logger.warn(`[OktaOidc] Retrying discovery against org-level auth server for ${idpHint}`);

    try {
      const orgIssuerUrl = getIssuerUrl(oktaConfig.audience, undefined, true);
      const config = await client.discovery(
        orgIssuerUrl,
        oktaConfig.clientId,
        { client_secret: oktaConfig.clientSecret },
        client.ClientSecretPost(oktaConfig.clientSecret)
      );

      // Cache under the ORG-LEVEL key - NOT the custom-server key the caller
      // originally hit. Storing org-level config under a custom-server key
      // creates a semantic mismatch that breaks across flapping discovery
      // (e.g. token endpoint resolved against a different issuer than the
      // authorization code was issued by).
      const orgCacheKey = `${normalizedAudience}:org:${oktaConfig.clientId}`;
      configurationCache.set(orgCacheKey, { config, timestamp: Date.now() });

      // Remember this audience only serves the org-level auth server so future
      // lookups skip the doomed custom discovery (and this whole fallback +
      // error-log path) for the rest of the process. Logs below therefore fire
      // at most once per audience per cold start instead of on every cache miss.
      const newlyDemoted = !orgLevelDemotedAudiences.has(demotionKey(oktaConfig));
      orgLevelDemotedAudiences.add(demotionKey(oktaConfig));

      if (idp?.id) {
        if (idp.oktaConfig) {
          try {
            await identityProviderRepository.updateIDP(idp.id, {
              oktaConfig: { ...idp.oktaConfig, useOrgAuthServer: true },
            });
            Logger.warn(`[OktaOidc] Auto-corrected IDP ${idp.id} to useOrgAuthServer=true`);
          } catch (persistError) {
            // Persistence failure is non-fatal - the current login still
            // succeeds via the cached org-level config, and the in-memory
            // demotion suppresses the retry for this process. Surface loudly so
            // an operator can correct the IDP manually.
            Logger.error(`[OktaOidc] Auto-correction persistence failed for IDP ${idp.id}`, persistError);
          }
        } else if (newlyDemoted) {
          Logger.error(
            `[OktaOidc] Cannot auto-correct IDP ${idp.id}: oktaConfig field is missing. ` +
              'Demoted to org-level in-memory for this process; repair the IDP record to make it permanent.'
          );
        }
      } else if (newlyDemoted) {
        // SST-sourced config can't be persisted (immutable secrets), but the
        // in-memory demotion now prevents the per-cache-miss recurrence. WARN
        // (not ERROR): auth succeeded and the noise is self-mitigated - fix the
        // secret to make it permanent across restarts.
        Logger.warn(
          '[OktaOidc] Org-level fallback succeeded for SST-sourced config; demoted this audience to ' +
            'org-level in-memory for this process. Point the OKTA_* SST secrets at the org-level issuer ' +
            '(or set useOrgAuthServer) to make this permanent across restarts.'
        );
      }

      return config;
    } catch (fallbackError) {
      Logger.error('[OktaOidc] Org-level fallback also failed', fallbackError);
      throw new AggregateError(
        [error, fallbackError],
        `Okta discovery failed for both ${authServerType} and org-level auth servers`
      );
    }
  }
}

/**
 * Generate PKCE parameters for authorization flow
 *
 * @returns Code verifier and code challenge
 */
export async function generatePkceParams(): Promise<PkceParams> {
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  return { codeVerifier, codeChallenge };
}

/**
 * Build the authorization URL with PKCE support
 *
 * Security Note on Nonce:
 * The nonce parameter is intentionally optional because this implementation
 * already provides strong replay attack protection through:
 * 1. JWT-based state tokens with expiration (5 minute TTL)
 * 2. PKCE code_verifier/code_challenge binding (prevents authorization code interception)
 * 3. State token includes audience claim bound to Okta OAuth flow
 *
 * Per RFC 6749 and OpenID Connect Core 1.0, nonce is REQUIRED only for implicit flow
 * (where ID token is returned directly). For authorization code flow with PKCE,
 * the combination of state + PKCE provides equivalent protection.
 *
 * If additional nonce validation is desired (defense-in-depth), pass a nonce
 * and validate the `nonce` claim in the ID token during the callback.
 *
 * @param oktaConfig - Okta configuration
 * @param redirectUri - Callback URL
 * @param pkceParams - PKCE code verifier and challenge
 * @param state - State parameter (e.g., JWT token)
 * @param nonce - Nonce for ID token validation (optional, see security note above)
 * @param idp - Source IDP document (forwarded to {@link getOidcConfiguration}
 *              so the org-level fallback can self-heal the IDP record on a
 *              detected misconfiguration). Not used here directly.
 * @returns Authorization URL
 */
export async function buildAuthorizationUrl(
  oktaConfig: OktaConfig,
  redirectUri: string,
  pkceParams: PkceParams,
  state: string,
  nonce?: string,
  idp?: IIdentityProviderDocument | null
): Promise<URL> {
  const config = await getOidcConfiguration(oktaConfig, idp);

  const parameters: Record<string, string> = {
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: pkceParams.codeChallenge,
    code_challenge_method: 'S256',
  };

  if (nonce) {
    parameters.nonce = nonce;
  }

  const authUrl = client.buildAuthorizationUrl(config, parameters);
  Logger.debug('[OktaOidc] Authorization URL built:', authUrl.toString().substring(0, LOG_URL_TRUNCATE_LENGTH) + '...');

  return authUrl;
}

/**
 * Exchange authorization code for tokens
 *
 * @param oktaConfig - Okta configuration
 * @param callbackUrl - The full callback URL with code and state
 * @param codeVerifier - PKCE code verifier from original authorization request
 * @param expectedState - Expected state value
 * @param idp - Source IDP document (forwarded to {@link getOidcConfiguration}
 *              for the org-level fallback's self-heal path). Not used here
 *              directly.
 * @returns Token response
 */
export async function exchangeCodeForTokens(
  oktaConfig: OktaConfig,
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string,
  idp?: IIdentityProviderDocument | null
): Promise<{
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  tokenResponse: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
}> {
  const config = await getOidcConfiguration(oktaConfig, idp);

  Logger.debug('[OktaOidc] Exchanging code for tokens');

  const tokenResponse = await client.authorizationCodeGrant(config, callbackUrl, {
    expectedState,
    pkceCodeVerifier: codeVerifier,
  });

  Logger.debug('[OktaOidc] Token exchange successful');

  return {
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token,
    refreshToken: tokenResponse.refresh_token,
    tokenResponse,
  };
}

/**
 * Fetch user info from Okta userinfo endpoint
 *
 * @param oktaConfig - Okta configuration
 * @param accessToken - Access token from token exchange
 * @param expectedSubject - Expected subject (sub claim) from ID token
 * @param idp - Source IDP document (forwarded to {@link getOidcConfiguration}
 *              for the org-level fallback's self-heal path). Not used here
 *              directly.
 * @returns User info response
 */
export async function fetchUserInfo(
  oktaConfig: OktaConfig,
  accessToken: string,
  expectedSubject: string,
  idp?: IIdentityProviderDocument | null
): Promise<{
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}> {
  const config = await getOidcConfiguration(oktaConfig, idp);

  Logger.debug('[OktaOidc] Fetching user info');

  const userInfo = await client.fetchUserInfo(config, accessToken, expectedSubject);

  Logger.debug('[OktaOidc] User info fetched for sub:', userInfo.sub);

  return userInfo as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
    family_name?: string;
    preferred_username?: string;
    [key: string]: unknown;
  };
}

/**
 * Resolve Okta configuration from database or SST secrets.
 * Database configuration takes precedence over SST secrets.
 *
 * Resolution order:
 * 1. If specific IDP ID provided, use that IDP
 * 2. If no IDP ID, look for any active Okta IDP in database
 * 3. Fall back to SST secrets if no database IDP exists
 *
 * @param idpId - Optional IDP ID to look up specific database config
 * @returns Configuration with source information
 */
export async function getOktaConfigWithFallback(idpId?: string): Promise<OktaConfigResult> {
  // Try database first if specific IDP ID provided
  if (idpId && idpId !== 'sst-fallback') {
    try {
      const idp = await identityProviderRepository.findById(idpId);
      const config = extractOktaConfigFromIdp(idp);
      if (config) {
        Logger.debug('[OktaOidc] Using database config for IDP:', idpId);
        return {
          config,
          source: 'database',
          idp: idp!,
        };
      }
    } catch (err) {
      Logger.error('[OktaOidc] Error fetching IDP config:', err);
    }
  }

  // If no IDP ID provided, look for any active Okta IDP in database
  // This allows "Login with Okta" button to work without requiring email domain lookup
  if (!idpId) {
    try {
      const allIdps = await identityProviderRepository.findAll();
      const activeOktaIdp = allIdps.find(idp => idp.type === 'okta' && idp.isActive);
      const config = extractOktaConfigFromIdp(activeOktaIdp);
      if (config && activeOktaIdp) {
        Logger.debug('[OktaOidc] Using database config for active Okta IDP:', activeOktaIdp.id);
        return {
          config,
          source: 'database',
          idp: activeOktaIdp,
        };
      }
    } catch (err) {
      Logger.error('[OktaOidc] Error fetching active Okta IDP:', err);
    }
  }

  // Fallback to SST secrets
  if (Config.OKTA_AUDIENCE && Config.OKTA_CLIENT_ID && Config.OKTA_CLIENT_SECRET) {
    // Validate none are placeholder values
    if (
      isPlaceholderValue(Config.OKTA_AUDIENCE) ||
      isPlaceholderValue(Config.OKTA_CLIENT_ID) ||
      isPlaceholderValue(Config.OKTA_CLIENT_SECRET)
    ) {
      Logger.debug('[OktaOidc] SST secrets contain placeholder values, Okta disabled');
      return { config: null, source: null };
    }
    Logger.debug('[OktaOidc] Using SST secrets config');
    // Opt SST-sourced config into the org-level auth server when the stage's
    // tenant has no custom auth server - skips the custom /oauth2/default
    // discovery that would otherwise fail (and log ERROR) on every cold start
    // before the in-memory demotion kicks in. Defaults false (custom-first).
    const useOrgAuthServer = Config.OKTA_USE_ORG_AUTH_SERVER === 'true';
    return {
      config: {
        audience: Config.OKTA_AUDIENCE,
        clientId: Config.OKTA_CLIENT_ID,
        clientSecret: Config.OKTA_CLIENT_SECRET,
        authServerId: useOrgAuthServer ? undefined : 'default',
        useOrgAuthServer,
      },
      source: 'sst',
    };
  }

  Logger.warn('[OktaOidc] No configuration available');
  return { config: null, source: null };
}

/**
 * Clear the configuration cache (useful for testing)
 */
export function clearConfigurationCache(): void {
  configurationCache.clear();
  orgLevelDemotedAudiences.clear();
  Logger.debug('[OktaOidc] Configuration cache cleared');
}

/**
 * Extract OktaConfig from an IDP document if it has valid Okta configuration.
 * Returns null if the IDP doesn't have complete Okta config.
 *
 * @param idp - Identity provider document
 * @returns OktaConfig if valid, null otherwise
 */
export function extractOktaConfigFromIdp(idp: IIdentityProviderDocument | null | undefined): OktaConfig | null {
  const oktaConfig = idp?.oktaConfig;
  if (!oktaConfig) {
    return null;
  }

  const { audience, clientId, clientSecret, authServerId, useOrgAuthServer } = oktaConfig;
  if (!audience || !clientId || !clientSecret) {
    return null;
  }

  return {
    audience,
    clientId,
    clientSecret,
    authServerId: authServerId || 'default',
    useOrgAuthServer: useOrgAuthServer ?? false,
  };
}

/**
 * Result of checking Okta configuration status
 */
export interface OktaConfigStatusResult {
  /** Whether SST secrets are fully configured */
  sstConfigured: boolean;
  /** Whether database IDP config exists and is complete */
  databaseConfigured: boolean;
  /** Which config source will be used (database takes precedence) */
  effectiveSource: 'sst' | 'database' | 'none';
  /** The effective config values (from whichever source is active) */
  effectiveConfig?: OktaConfig;
}

/**
 * Get the status of Okta configuration from both sources.
 * Used by system health checks to show configuration status.
 *
 * @returns Configuration status for both SST and database sources
 */
export async function getOktaConfigStatus(): Promise<OktaConfigStatusResult> {
  // Check SST configuration
  const sstConfigured = !!(Config.OKTA_AUDIENCE && Config.OKTA_CLIENT_ID && Config.OKTA_CLIENT_SECRET);

  // Check database configuration
  let databaseConfigured = false;
  let databaseConfig: OktaConfig | undefined;
  try {
    const allIdps = await identityProviderRepository.findAll();
    const activeOktaIdp = allIdps.find(idp => idp.type === 'okta' && idp.isActive);
    const config = extractOktaConfigFromIdp(activeOktaIdp);
    if (config) {
      databaseConfigured = true;
      databaseConfig = config;
    }
  } catch (error) {
    Logger.error('[OktaOidc] Error checking database IDP config:', error);
    // Continue without database check - SST config may still work
  }

  // Database takes precedence over SST
  const effectiveSource: 'sst' | 'database' | 'none' = databaseConfigured ? 'database' : sstConfigured ? 'sst' : 'none';

  // Build effective config based on source
  let effectiveConfig: OktaConfig | undefined;
  if (effectiveSource === 'database' && databaseConfig) {
    effectiveConfig = databaseConfig;
  } else if (effectiveSource === 'sst') {
    const useOrgAuthServer = Config.OKTA_USE_ORG_AUTH_SERVER === 'true';
    effectiveConfig = {
      audience: Config.OKTA_AUDIENCE,
      clientId: Config.OKTA_CLIENT_ID,
      clientSecret: Config.OKTA_CLIENT_SECRET,
      authServerId: useOrgAuthServer ? undefined : 'default',
      useOrgAuthServer,
    };
  }

  return {
    sstConfigured,
    databaseConfigured,
    effectiveSource,
    effectiveConfig,
  };
}
