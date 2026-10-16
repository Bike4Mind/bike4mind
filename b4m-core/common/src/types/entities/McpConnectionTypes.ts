import { z } from 'zod';
import { ConflictError } from '../../errors';
import type { IntegrationId } from '../../integrations/catalog';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { McpServerName } from './McpServerTypes';

/**
 * Custom remote MCP connectors: a user (or an org admin publishing a definition) connects any
 * remote MCP server by URL. Built-in servers stay on `McpServer`; this is a separate collection so
 * the built-in name enum and its env-variable credential shape are untouched.
 *
 * Every `*Enc` field holds ciphertext from `encryptToken` (`@bike4mind/utils/security`); the caller
 * encrypts before writing and decrypts after a `*WithCredentials` read, exactly as `McpServer`
 * env variables are handled. Those fields are `select: false` on the schema and never leave the
 * server: API responses go through {@link toMcpConnectionPublic}.
 */

export const MCP_CONNECTION_OWNER_TYPES = ['user', 'org'] as const;
/** `org` is an org-published definition: it carries no tokens, each member connects their own. */
export type McpConnectionOwnerType = (typeof MCP_CONNECTION_OWNER_TYPES)[number];

export const MCP_CONNECTION_TRANSPORTS = ['auto', 'streamable-http', 'sse'] as const;
export type McpConnectionTransport = (typeof MCP_CONNECTION_TRANSPORTS)[number];
export type McpConnectionDetectedTransport = Exclude<McpConnectionTransport, 'auto'>;

export const MCP_CONNECTION_AUTH_KINDS = ['oauth', 'api_key', 'none'] as const;
export type McpConnectionAuthKind = (typeof MCP_CONNECTION_AUTH_KINDS)[number];

export const MCP_OAUTH_CLIENT_MODES = ['preregistered', 'cimd', 'dcr', 'manual'] as const;
export type McpOAuthClientMode = (typeof MCP_OAUTH_CLIENT_MODES)[number];

export const MCP_API_KEY_SCHEMES = ['Bearer', 'raw'] as const;
export type McpApiKeyScheme = (typeof MCP_API_KEY_SCHEMES)[number];

/**
 * Stored lifecycle states. Policy blocking is deliberately not one of them: policy changes (an org
 * tightening its allowlist, a platform host block) would otherwise need a sweep to set it and
 * another to undo it. It is derived at read and offer time by {@link effectiveMcpConnectionStatus}.
 */
export const MCP_CONNECTION_STATUSES = ['pending_auth', 'connected', 'needs_reconnect', 'error'] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export type McpConnectionEffectiveStatus = McpConnectionStatus | 'blocked_by_policy';

/** Structural, so the policy evaluator's richer verdict (with a reason) fits as is. */
export interface McpPolicyVerdictLike {
  allowed: boolean;
}

/** The status to show or act on: the stored one, unless the current policy blocks the connection. */
export function effectiveMcpConnectionStatus(
  connection: Pick<IMcpConnection, 'status'>,
  policyVerdict: McpPolicyVerdictLike
): McpConnectionEffectiveStatus {
  return policyVerdict.allowed ? connection.status : 'blocked_by_policy';
}

export const MCP_TOOL_APPROVAL_MODES = ['default', 'always_allow', 'always_ask'] as const;
export type McpToolApprovalMode = (typeof MCP_TOOL_APPROVAL_MODES)[number];

/** New or changed tools land as `pending_review` and disabled until the user reviews them. */
export const MCP_TOOL_STATES = ['active', 'pending_review'] as const;
export type McpToolState = (typeof MCP_TOOL_STATES)[number];

export interface IMcpConnectionOAuth {
  resource: string;
  resourceMetadataUrl?: string;
  issuer: string;
  authorizationServerUrl: string;
  /** Endpoints from the authorization-server metadata, recorded at discovery so refresh and revoke skip it. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  /** RFC 7591 `token_endpoint_auth_method` for this client (`none`, `client_secret_post`, ...). */
  tokenEndpointAuthMethod?: string;
  /** RFC 9207: the server sends `iss` on the authorization response, so the callback must check it. */
  issParameterSupported?: boolean;
  scopes: string[];
  clientMode: McpOAuthClientMode;
  /** Id of the shared `McpOAuthClientRegistration` row when `clientMode` is `dcr`. */
  clientRegistrationId?: string;
  manualClientIdEnc?: string;
  manualClientSecretEnc?: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  /**
   * Non-secret presence markers, written in the same update as the ciphertext (the token fields are
   * `select: false`, so a default read cannot see whether they are set). The public view reads these.
   */
  hasAccessToken?: boolean;
  hasRefreshToken?: boolean;
  expiresAt?: Date;
  grantedScope?: string;
  tokenIssuer?: string;
}

export interface IMcpConnectionApiKey {
  headerName: string;
  scheme?: McpApiKeyScheme;
  /** Write-only: never returned to the client, only `last4`. */
  valueEnc: string;
  last4: string;
}

export interface IMcpConnectionAuth {
  kind: McpConnectionAuthKind;
  oauth?: IMcpConnectionOAuth;
  apiKey?: IMcpConnectionApiKey;
}

/** Tool annotations as reported by the server. Hints from an untrusted source, never a guarantee. */
export interface IMcpConnectionToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface IMcpConnectionTool {
  name: string;
  title?: string;
  /** Cleaned description (what the model sees). */
  description: string;
  /** sha256 of the raw server description, so a change is detected even when cleaning hides it. */
  descriptionRawHash: string;
  inputSchema: Record<string, unknown>;
  annotations?: IMcpConnectionToolAnnotations;
  enabled: boolean;
  approval: McpToolApprovalMode;
  state: McpToolState;
  firstSeenAt: Date;
}

/** Without the input schema: what the manage list, org views and sweeps read. */
export type IMcpConnectionToolSummary = Omit<IMcpConnectionTool, 'inputSchema'>;

/**
 * `RemoteMcpErrorCode` from `@bike4mind/mcp` (b4m-core/mcp/src/remote/errors.ts, which asserts at
 * compile time that its codes stay a subset of this list) plus the codes the app tier adds.
 */
export const MCP_CONNECTION_ERROR_CODES = [
  'invalid_url',
  'ssrf_blocked',
  'timeout',
  'auth_required',
  'auth_failed',
  'protocol',
  'size_cap',
  'upstream_5xx',
  'policy_blocked',
  'invalid_grant',
  'insufficient_scope',
] as const;
export type McpConnectionErrorCode = (typeof MCP_CONNECTION_ERROR_CODES)[number];

export interface IMcpConnectionLastError {
  code: McpConnectionErrorCode;
  message: string;
  at: Date;
  /** Scope a 403 `insufficient_scope` asked for; reconnecting requests it (step-up). */
  requiredScope?: string;
}

/** Server `instructions` are deliberately not stored in v1 (prompt-injection surface). */
export interface IMcpConnectionServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** Single-writer lease for OAuth refresh; see `acquireRefreshLease`. */
export interface IMcpConnectionRefreshLease {
  holder: string;
  until: Date;
}

export interface IMcpConnection {
  ownerType: McpConnectionOwnerType;
  /** userId for `user`, organizationId for `org`; the slug is unique per (ownerType, ownerKey). */
  ownerKey: string;
  /** Creator; for `user` connections, also the credential owner. */
  userId: string;
  organizationId?: string;
  /** Org definition this user connection was instantiated from. */
  definitionId?: string;
  presetId?: IntegrationId;
  slug: string;
  displayName: string;
  /**
   * Ciphertext of the normalized URL (lowercased host, no fragment, no userinfo), because servers
   * often carry a key in the query or path. The caller encrypts with `encryptToken` and decrypts
   * after a `*WithCredentials` read, like every other `*Enc` field.
   */
  urlEnc: string;
  /** Safe to show: see {@link toMcpDisplayUrl}. */
  displayUrl: string;
  /**
   * Lowercased hostname without the port (`URL.hostname`); what host patterns and the blocklist
   * match, so they apply to every port on the host.
   */
  urlHost: string;
  transport: McpConnectionTransport;
  detectedTransport?: McpConnectionDetectedTransport;
  auth: IMcpConnectionAuth;
  status: McpConnectionStatus;
  lastError?: IMcpConnectionLastError;
  serverInfo?: IMcpConnectionServerInfo;
  tools: IMcpConnectionTool[];
  toolsFingerprint?: string;
  toolsFetchedAt?: Date;
  /** Tools the server listed that discovery refused (invalid name, over a cap). */
  toolsDropped?: number;
  enabled: boolean;
  lastUsedAt?: Date;
  refreshLease?: IMcpConnectionRefreshLease;
}

export interface IMcpConnectionDocument extends IMcpConnection, IMongoDocument {}

/** Slim read (no `tools.inputSchema`) returned by the list and sweep queries. */
export type IMcpConnectionSummary = Omit<IMcpConnectionDocument, 'tools'> & { tools: IMcpConnectionToolSummary[] };

/**
 * Storage bounds enforced by the McpConnection schema. Discovery (c3) caps and truncates below
 * these before writing; the schema is the backstop against a document that grows without limit.
 */
export const MCP_CONNECTION_LIMITS = {
  maxTools: 100,
  /** Serialized size of the whole `tools` array, in bytes. */
  maxToolsBytes: 512 * 1024,
  toolNameLength: 64,
  toolDescriptionLength: 1024,
  lastErrorMessageLength: 1000,
  serverInfoFieldLength: 200,
  displayNameLength: 100,
  maxScopes: 50,
  requiredScopeLength: 1000,
} as const;

/** Dotted paths of the auth secrets. An org definition may carry none of them (members connect their own). */
export const MCP_CONNECTION_CREDENTIAL_PATHS = [
  'auth.oauth.manualClientIdEnc',
  'auth.oauth.manualClientSecretEnc',
  'auth.oauth.accessTokenEnc',
  'auth.oauth.refreshTokenEnc',
  'auth.apiKey.valueEnc',
] as const;

/**
 * Dotted paths of every secret on a connection. Single source for the schema's `select: false`,
 * the `+path` opt-in on credential reads, and the projection test.
 */
export const MCP_CONNECTION_SECRET_PATHS = [...MCP_CONNECTION_CREDENTIAL_PATHS, 'urlEnc'] as const;

/** Path segments this long or longer are treated as possible secrets and masked in the display URL. */
export const MCP_DISPLAY_URL_MASK_MIN_SEGMENT = 20;

/**
 * Origin plus path with the query dropped and every long path segment masked to `...` plus its last
 * 4 characters. The origin keeps a non-default port. Throws on an unparseable URL; callers pass the
 * already-validated normalized URL.
 */
export function toMcpDisplayUrl(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname
    .split('/')
    .map(segment => (segment.length >= MCP_DISPLAY_URL_MASK_MIN_SEGMENT ? `...${segment.slice(-4)}` : segment))
    .join('/');
  return `${parsed.origin}${path}`;
}

/**
 * Why the owner fields are inconsistent, or null. `user`: `ownerKey === userId`. `org`: an
 * `organizationId` equal to `ownerKey`, and no credential or refresh lease on the definition.
 */
export function mcpConnectionOwnerProblem(
  doc: Pick<IMcpConnection, 'ownerType' | 'ownerKey' | 'userId' | 'organizationId' | 'refreshLease'> & {
    auth?: unknown;
  }
): string | null {
  if (doc.ownerType === 'user') {
    return doc.ownerKey === doc.userId ? null : 'A user connection must have ownerKey equal to userId';
  }
  if (doc.ownerType !== 'org') return `Unknown ownerType ${String(doc.ownerType)}`;
  if (!doc.organizationId || doc.ownerKey !== doc.organizationId) {
    return 'An org definition must have ownerKey equal to organizationId';
  }
  if (doc.refreshLease) return 'An org definition cannot hold a refresh lease';
  const credential = MCP_CONNECTION_CREDENTIAL_PATHS.find(
    path =>
      path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc) !==
      undefined
  );
  return credential ? `An org definition cannot carry ${credential}` : null;
}

/** Client-safe view: no ciphertext (the URL included), no lease. Token presence is reported as booleans only. */
export interface IMcpConnectionPublic {
  id: string;
  ownerType: McpConnectionOwnerType;
  userId: string;
  organizationId?: string;
  definitionId?: string;
  presetId?: IntegrationId;
  slug: string;
  displayName: string;
  displayUrl: string;
  urlHost: string;
  transport: McpConnectionTransport;
  detectedTransport?: McpConnectionDetectedTransport;
  auth: {
    kind: McpConnectionAuthKind;
    oauth?: {
      issuer: string;
      scopes: string[];
      clientMode: McpOAuthClientMode;
      expiresAt?: Date;
      grantedScope?: string;
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
    };
    apiKey?: { headerName: string; scheme?: McpApiKeyScheme; last4: string };
  };
  status: McpConnectionEffectiveStatus;
  lastError?: IMcpConnectionLastError;
  serverInfo?: IMcpConnectionServerInfo;
  /** `inputSchema` is present only when the view was built from a full read. */
  tools: (IMcpConnectionToolSummary & { inputSchema?: Record<string, unknown> })[];
  toolsFingerprint?: string;
  toolsFetchedAt?: Date;
  toolsDropped?: number;
  enabled: boolean;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build the client-safe view field by field. An allowlist rather than an omit, so a secret field
 * added to the document later stays server-side until someone deliberately exposes it here.
 */
export function toMcpConnectionPublic(
  doc: IMcpConnectionDocument | IMcpConnectionSummary,
  /** Pass the current policy verdict so the view reports `blocked_by_policy`; omitted, the stored status. */
  policyVerdict?: McpPolicyVerdictLike
): IMcpConnectionPublic {
  const { oauth, apiKey } = doc.auth ?? { kind: 'none' };
  return {
    id: doc.id,
    ownerType: doc.ownerType,
    userId: doc.userId,
    organizationId: doc.organizationId,
    definitionId: doc.definitionId,
    presetId: doc.presetId,
    slug: doc.slug,
    displayName: doc.displayName,
    displayUrl: doc.displayUrl,
    urlHost: doc.urlHost,
    transport: doc.transport,
    detectedTransport: doc.detectedTransport,
    auth: {
      kind: doc.auth?.kind ?? 'none',
      ...(oauth
        ? {
            oauth: {
              issuer: oauth.issuer,
              scopes: oauth.scopes ?? [],
              clientMode: oauth.clientMode,
              expiresAt: oauth.expiresAt,
              grantedScope: oauth.grantedScope,
              hasAccessToken: oauth.hasAccessToken === true,
              hasRefreshToken: oauth.hasRefreshToken === true,
            },
          }
        : {}),
      ...(apiKey ? { apiKey: { headerName: apiKey.headerName, scheme: apiKey.scheme, last4: apiKey.last4 } } : {}),
    },
    status: policyVerdict ? effectiveMcpConnectionStatus(doc, policyVerdict) : doc.status,
    lastError: doc.lastError,
    serverInfo: doc.serverInfo,
    tools: doc.tools ?? [],
    toolsFingerprint: doc.toolsFingerprint,
    toolsFetchedAt: doc.toolsFetchedAt,
    toolsDropped: doc.toolsDropped,
    enabled: doc.enabled,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Namespace for the connection's tools (`<slug>__<tool>`), so it must stay short and unambiguous:
 * 2-20 characters, a leading letter, and single underscores between alphanumeric runs. No `__`
 * (the namespace separator) and no trailing `_`, which would make `<slug>__<tool>` ambiguous.
 */
export const MCP_CONNECTION_SLUG_PATTERN = /^(?=.{2,20}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Slugs a custom connection may never take: every built-in server name (so `<slug>__<tool>` can
 * never collide with a built-in tool, and `mcpPendingAction` can keep trusting `_confirmToken`
 * only from built-ins), plus names that would read as first-party.
 */
export const RESERVED_MCP_CONNECTION_SLUGS: ReadonlySet<string> = new Set([
  'github',
  'atlassian',
  'notion',
  'linkedin',
  'mcp',
  'b4m',
  'bike4mind',
  'slack',
  'system',
  ...Object.values(McpServerName),
]);

export const McpConnectionSlugSchema = z
  .string()
  .regex(MCP_CONNECTION_SLUG_PATTERN, {
    message:
      'Slug must be 2-20 characters: a lowercase letter, then lowercase letters, digits and single underscores, not ending in an underscore',
  })
  .refine(slug => !RESERVED_MCP_CONNECTION_SLUGS.has(slug), { message: 'This slug is reserved' });

export function isValidMcpConnectionSlug(slug: string): boolean {
  return McpConnectionSlugSchema.safeParse(slug).success;
}

export type McpConnectionLastErrorInput = Omit<IMcpConnectionLastError, 'at'>;

export interface McpConnectionOwner {
  ownerType: McpConnectionOwnerType;
  ownerKey: string;
}

export interface McpOAuthTokenUpdate {
  accessTokenEnc: string;
  /** Omit to keep the stored refresh token (a server that does not rotate it). */
  refreshTokenEnc?: string;
  expiresAt?: Date;
  grantedScope?: string;
  tokenIssuer?: string;
}

/**
 * Top-level fields the generic `update`/`updateGuarded`/`updateMany` refuse. They `$set` whole
 * fields, so writing `auth` back from a default read (where every `*Enc` is deselected) would wipe
 * the stored secrets; the lease and the owner identity have their own guarded writers or none.
 */
export const MCP_CONNECTION_PROTECTED_FIELDS = [
  'auth',
  'refreshLease',
  'ownerType',
  'ownerKey',
  'userId',
  'organizationId',
] as const;

/** A generic repository write named a field only the dedicated McpConnection methods may touch. */
export class McpConnectionProtectedFieldError extends Error {
  constructor(readonly field: string) {
    super(`McpConnection.${field} cannot be written through a generic update; use the dedicated repository method`);
    this.name = 'McpConnectionProtectedFieldError';
  }
}

/** The slug is already taken for this owner (the `mcpconn_owner_slug` unique index). */
export class McpConnectionSlugConflictError extends ConflictError {
  constructor(readonly slug: string) {
    super(`A connection with the slug "${slug}" already exists`, { slug });
    this.name = 'McpConnectionSlugConflictError';
  }
}

/**
 * `acquired` carries the connection with credentials (the winner is about to spend the refresh
 * token). `held`: another caller owns an unexpired lease; poll the record for its rotated token.
 * `not_found`: deleted, or not a user connection; stop.
 */
export type McpRefreshLeaseResult =
  | { outcome: 'acquired'; connection: IMcpConnectionDocument }
  | { outcome: 'held'; holder?: string; until?: Date }
  | { outcome: 'not_found' };

/** One tool's review choices. Omitted fields are left as stored; unknown tool names are ignored. */
export interface McpToolSettingsUpdate {
  name: string;
  enabled?: boolean;
  approval?: McpToolApprovalMode;
  state?: McpToolState;
}

export interface McpDiscoveryUpdate {
  tools: IMcpConnectionTool[];
  fingerprint: string;
  /** Fingerprint the caller read and diffed against; null for the first discovery. */
  expectedFingerprint: string | null;
  detectedTransport?: McpConnectionDetectedTransport;
  serverInfo?: IMcpConnectionServerInfo;
  dropped?: number;
}

export interface IMcpConnectionRepository extends IBaseRepository<IMcpConnectionDocument> {
  findByIdForOwner(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null>;
  /** Includes the `*Enc` fields. Only for the token manager and the call path, never a response. */
  findByIdWithCredentials(id: string): Promise<IMcpConnectionDocument | null>;
  /**
   * Hot path: the user's enabled, connected connections offered to a chat turn or agent run, with
   * the tool input schemas tool building needs. `slugs` narrows to the connections a turn selected.
   */
  listForUser(userId: string, options?: { slugs?: string[] }): Promise<IMcpConnectionDocument[]>;
  /** Every user-owned connection regardless of state, for the manage list. */
  listAllForUser(userId: string): Promise<IMcpConnectionSummary[]>;
  countForUser(userId: string): Promise<number>;
  /** Org-published definitions. */
  listForOrg(organizationId: string): Promise<IMcpConnectionSummary[]>;
  findByUrlHost(urlHost: string): Promise<IMcpConnectionSummary[]>;
  /** Members' own (user-owned) connections inside an org, for admin views and policy sweeps. */
  listMemberConnections(organizationId: string, options?: { urlHost?: string }): Promise<IMcpConnectionSummary[]>;
  /** User connections instantiated from an org definition. */
  findByDefinitionId(definitionId: string): Promise<IMcpConnectionSummary[]>;
  /** Cascade when an org definition is removed; resolves the number deleted. Revocation is the caller's. */
  deleteByDefinitionId(definitionId: string): Promise<number>;
  /** Account deletion: every user-owned connection; org definitions the user created stay with the org. */
  deleteAllForUser(userId: string): Promise<number>;
  rename(id: string, owner: McpConnectionOwner, displayName: string): Promise<IMcpConnectionDocument | null>;
  setEnabled(id: string, owner: McpConnectionOwner, enabled: boolean): Promise<IMcpConnectionDocument | null>;
  /** Applies every entry in one atomic write. */
  setToolSettings(
    id: string,
    owner: McpConnectionOwner,
    settings: McpToolSettingsUpdate[]
  ): Promise<IMcpConnectionDocument | null>;
  /**
   * Compare-and-set on `toolsFingerprint === expectedFingerprint`: resolves null when another
   * discovery already moved the fingerprint, so the caller re-reads and re-diffs instead of
   * overwriting the review choices that discovery merged.
   */
  updateDiscovery(id: string, update: McpDiscoveryUpdate): Promise<IMcpConnectionDocument | null>;
  /** `connected` clears any stale `lastError`; `pending_auth` leaves it as the reason to reconnect. */
  setStatus(id: string, status: 'connected' | 'pending_auth'): Promise<IMcpConnectionDocument | null>;
  /** A failure status always records why. */
  setStatus(
    id: string,
    status: 'error' | 'needs_reconnect',
    lastError: McpConnectionLastErrorInput
  ): Promise<IMcpConnectionDocument | null>;
  /**
   * Store refreshed tokens and drop the lease in one write, only while `holder` still owns it.
   * Null means the lease was lost (taken over after expiry, or the connection is gone or not OAuth):
   * the caller must not retry the write, because the successor's rotated token is the live one.
   */
  completeRefresh(id: string, holder: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null>;
  /** Disconnect: drop the tokens, their markers and any lease. Revocation at the server is the caller's. */
  clearOAuthTokens(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null>;
  /** First code exchange; there is no lease yet. Null when the connection is gone or not OAuth. */
  setInitialOAuthTokens(id: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null>;
  markUsed(id: string): Promise<void>;
  acquireRefreshLease(id: string, holder: string, ttlMs?: number): Promise<McpRefreshLeaseResult>;
  releaseRefreshLease(id: string, holder: string): Promise<boolean>;
  deleteForOwner(id: string, owner: McpConnectionOwner): Promise<boolean>;
}

/** Single-use, server-side OAuth state for one authorization attempt (PKCE needs it anyway). */
export interface IMcpOAuthPending {
  /** sha256 of the `state` sent to the authorization server; the raw state is never stored. */
  stateHash: string;
  userId: string;
  connectionId: string;
  codeVerifierEnc: string;
  redirectUri: string;
  issuer: string;
  resource: string;
  scopes: string[];
  consumedAt?: Date | null;
}

export interface IMcpOAuthPendingDocument extends IMcpOAuthPending, IMongoDocument {}

/** Pending rows expire this long after creation (TTL index). */
export const MCP_OAUTH_PENDING_TTL_SECONDS = 600;

export interface IMcpOAuthPendingRepository extends IBaseRepository<IMcpOAuthPendingDocument> {
  /**
   * Atomically marks the state consumed; resolves null when unknown, expired, already used, or
   * started by a different user (the callback passes the session's user).
   */
  consume(stateHash: string, userId: string): Promise<IMcpOAuthPendingDocument | null>;
}

/** Dynamic Client Registration result, shared per (authorization server, redirect URI). */
export interface IMcpOAuthClientRegistration {
  issuer: string;
  redirectUri: string;
  clientId: string;
  clientSecretEnc?: string;
  /** Absent means the secret never expires (RFC 7591 `client_secret_expires_at: 0`); past it, lookups miss. */
  clientSecretExpiresAt?: Date;
  registrationAccessTokenEnc?: string;
  tokenEndpointAuthMethod: string;
}

export interface IMcpOAuthClientRegistrationDocument extends IMcpOAuthClientRegistration, IMongoDocument {}

export interface IMcpOAuthClientRegistrationRepository extends IBaseRepository<IMcpOAuthClientRegistrationDocument> {
  upsert(registration: IMcpOAuthClientRegistration): Promise<IMcpOAuthClientRegistrationDocument>;
  /** Includes `clientSecretEnc` and `registrationAccessTokenEnc`. */
  findByIssuerAndRedirect(issuer: string, redirectUri: string): Promise<IMcpOAuthClientRegistrationDocument | null>;
}
