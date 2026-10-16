import { z } from 'zod';
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

export const MCP_CONNECTION_STATUSES = [
  'pending_auth',
  'connected',
  'needs_reconnect',
  'error',
  'blocked_by_policy',
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

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
  scopes: string[];
  clientMode: McpOAuthClientMode;
  /** Id of the shared `McpOAuthClientRegistration` row when `clientMode` is `dcr`. */
  clientRegistrationId?: string;
  manualClientIdEnc?: string;
  manualClientSecretEnc?: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
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

export interface IMcpConnectionLastError {
  code: string;
  message: string;
  at: Date;
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
  /** Normalized: lowercased host, no fragment, no userinfo. */
  url: string;
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

/**
 * Dotted paths of every secret on a connection. Single source for the schema's `select: false`,
 * the `+path` opt-in on credential reads, and the projection test.
 */
export const MCP_CONNECTION_SECRET_PATHS = [
  'auth.oauth.manualClientIdEnc',
  'auth.oauth.manualClientSecretEnc',
  'auth.oauth.accessTokenEnc',
  'auth.oauth.refreshTokenEnc',
  'auth.apiKey.valueEnc',
] as const;

/** Client-safe view: no ciphertext, no lease. Token presence is reported as booleans only. */
export interface IMcpConnectionPublic {
  id: string;
  ownerType: McpConnectionOwnerType;
  userId: string;
  organizationId?: string;
  definitionId?: string;
  presetId?: IntegrationId;
  slug: string;
  displayName: string;
  url: string;
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
  status: McpConnectionStatus;
  lastError?: IMcpConnectionLastError;
  serverInfo?: IMcpConnectionServerInfo;
  tools: IMcpConnectionTool[];
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
export function toMcpConnectionPublic(doc: IMcpConnectionDocument): IMcpConnectionPublic {
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
    url: doc.url,
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
              hasAccessToken: Boolean(oauth.accessTokenEnc),
              hasRefreshToken: Boolean(oauth.refreshTokenEnc),
            },
          }
        : {}),
      ...(apiKey ? { apiKey: { headerName: apiKey.headerName, scheme: apiKey.scheme, last4: apiKey.last4 } } : {}),
    },
    status: doc.status,
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

/** Namespace for the connection's tools (`<slug>__<tool>`), so it must stay short and unambiguous. */
export const MCP_CONNECTION_SLUG_PATTERN = /^[a-z][a-z0-9_]{1,19}$/;

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
    message: 'Slug must start with a lowercase letter and use 2-20 lowercase letters, digits or underscores',
  })
  .refine(slug => !RESERVED_MCP_CONNECTION_SLUGS.has(slug), { message: 'This slug is reserved' });

export function isValidMcpConnectionSlug(slug: string): boolean {
  return McpConnectionSlugSchema.safeParse(slug).success;
}

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
  /** Hot path: the user's enabled, connected connections offered to a chat turn or agent run. */
  listForUser(userId: string): Promise<IMcpConnectionDocument[]>;
  /** Every user-owned connection regardless of state, for the manage list. */
  listAllForUser(userId: string): Promise<IMcpConnectionDocument[]>;
  countForUser(userId: string): Promise<number>;
  /** Org-published definitions. */
  listForOrg(organizationId: string): Promise<IMcpConnectionDocument[]>;
  findByUrlHost(urlHost: string): Promise<IMcpConnectionDocument[]>;
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
  setStatus(
    id: string,
    status: McpConnectionStatus,
    lastError?: Omit<IMcpConnectionLastError, 'at'>
  ): Promise<IMcpConnectionDocument | null>;
  /**
   * Store refreshed tokens and drop the lease in one write, only while `holder` still owns it.
   * Null means the lease was lost (taken over after expiry, or the connection is gone or not OAuth):
   * the caller must not retry the write, because the successor's rotated token is the live one.
   */
  completeRefresh(id: string, holder: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null>;
  /** First code exchange; there is no lease yet. Null when the connection is gone or not OAuth. */
  setInitialOAuthTokens(id: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null>;
  markUsed(id: string): Promise<void>;
  acquireRefreshLease(id: string, holder: string, ttlMs?: number): Promise<IMcpConnectionDocument | null>;
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
  /** Atomically marks the state consumed; resolves null when unknown, expired or already used. */
  consume(stateHash: string): Promise<IMcpOAuthPendingDocument | null>;
}

/** Dynamic Client Registration result, shared per (authorization server, redirect URI). */
export interface IMcpOAuthClientRegistration {
  issuer: string;
  redirectUri: string;
  clientId: string;
  clientSecretEnc?: string;
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
