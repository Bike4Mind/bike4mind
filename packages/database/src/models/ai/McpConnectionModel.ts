import {
  IMcpConnectionDocument,
  IMcpConnectionRepository,
  IMcpConnectionSummary,
  IMcpConnectionTool,
  McpConnectionLastErrorInput,
  IMongoDocument,
  McpConnectionOwner,
  McpConnectionProtectedFieldError,
  McpConnectionSlugConflictError,
  McpRefreshLeaseResult,
  McpConnectionStatus,
  McpDiscoveryUpdate,
  McpOAuthTokenUpdate,
  McpToolSettingsUpdate,
  MCP_CONNECTION_LIMITS,
  MCP_CONNECTION_PROTECTED_FIELDS,
  mcpConnectionOwnerProblem,
  RepositoryPatch,
  RepositoryUpdateOptions,
  MCP_API_KEY_SCHEMES,
  MCP_CONNECTION_AUTH_KINDS,
  MCP_CONNECTION_ERROR_CODES,
  MCP_CONNECTION_OWNER_TYPES,
  MCP_CONNECTION_SECRET_PATHS,
  MCP_CONNECTION_SLUG_PATTERN,
  MCP_CONNECTION_STATUSES,
  MCP_CONNECTION_TRANSPORTS,
  MCP_OAUTH_CLIENT_MODES,
  MCP_TOOL_APPROVAL_MODES,
  MCP_TOOL_STATES,
  isValidMcpConnectionSlug,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

/** How long a refresh lease is held before another caller may take it over (design 4.7). */
export const MCP_REFRESH_LEASE_TTL_MS = 15_000;

export class McpConnectionOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionOwnerError';
  }
}

const McpConnectionToolSchema = new Schema<IMcpConnectionTool>(
  {
    name: { type: String, required: true, maxlength: MCP_CONNECTION_LIMITS.toolNameLength },
    title: { type: String, maxlength: MCP_CONNECTION_LIMITS.serverInfoFieldLength },
    description: { type: String, default: '', maxlength: MCP_CONNECTION_LIMITS.toolDescriptionLength },
    descriptionRawHash: { type: String, required: true },
    inputSchema: { type: Schema.Types.Mixed, default: {} },
    annotations: { type: Schema.Types.Mixed },
    enabled: { type: Boolean, required: true },
    approval: { type: String, enum: MCP_TOOL_APPROVAL_MODES, default: 'default' },
    state: { type: String, enum: MCP_TOOL_STATES, required: true },
    firstSeenAt: { type: Date, required: true },
  },
  { _id: false }
);

function toolsWithinBounds(tools: unknown): boolean {
  if (!Array.isArray(tools)) return true;
  if (tools.length > MCP_CONNECTION_LIMITS.maxTools) return false;
  return Buffer.byteLength(JSON.stringify(tools)) <= MCP_CONNECTION_LIMITS.maxToolsBytes;
}

const serverInfoField = { type: String, maxlength: MCP_CONNECTION_LIMITS.serverInfoFieldLength };

const MCP_CONNECTION_DETECTED_TRANSPORTS = MCP_CONNECTION_TRANSPORTS.filter(transport => transport !== 'auto');

function normalizeUrlHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

// Secrets are `select: false` (see MCP_CONNECTION_SECRET_PATHS); credential reads opt back in.
// `aggregate()`, `distinct()` and the raw driver collection bypass `select: false`: never point one
// at this collection without an explicit projection that drops every secret path.
const McpConnectionSchema = new Schema<IMcpConnectionDocument>(
  {
    ownerType: { type: String, enum: MCP_CONNECTION_OWNER_TYPES, required: true },
    ownerKey: { type: String, required: true },
    userId: { type: String, required: true },
    organizationId: { type: String },
    definitionId: { type: String },
    presetId: { type: String },
    slug: {
      type: String,
      required: true,
      match: MCP_CONNECTION_SLUG_PATTERN,
      validate: { validator: isValidMcpConnectionSlug, message: 'This slug is reserved' },
    },
    displayName: { type: String, required: true, maxlength: MCP_CONNECTION_LIMITS.displayNameLength },
    urlEnc: { type: String, required: true, select: false },
    displayUrl: { type: String, required: true },
    // Host-policy patterns are lowercase with no trailing dot, so store the host the same way:
    // `evil.com.` must not slip past a blocklist entry for `evil.com`.
    urlHost: { type: String, required: true, set: normalizeUrlHost },
    transport: { type: String, enum: MCP_CONNECTION_TRANSPORTS, default: 'auto' },
    detectedTransport: { type: String, enum: MCP_CONNECTION_DETECTED_TRANSPORTS },
    auth: {
      kind: { type: String, enum: MCP_CONNECTION_AUTH_KINDS, required: true },
      oauth: {
        type: new Schema(
          {
            resource: { type: String, required: true },
            resourceMetadataUrl: { type: String },
            issuer: { type: String, required: true },
            authorizationServerUrl: { type: String, required: true },
            tokenEndpoint: { type: String },
            revocationEndpoint: { type: String },
            registrationEndpoint: { type: String },
            tokenEndpointAuthMethod: { type: String },
            issParameterSupported: { type: Boolean },
            scopes: {
              type: [String],
              default: [],
              validate: {
                validator: (scopes: unknown) =>
                  !Array.isArray(scopes) || scopes.length <= MCP_CONNECTION_LIMITS.maxScopes,
                message: `At most ${MCP_CONNECTION_LIMITS.maxScopes} OAuth scopes`,
              },
            },
            clientMode: { type: String, enum: MCP_OAUTH_CLIENT_MODES, required: true },
            clientRegistrationId: { type: String },
            manualClientIdEnc: { type: String, select: false },
            manualClientSecretEnc: { type: String, select: false },
            accessTokenEnc: { type: String, select: false },
            refreshTokenEnc: { type: String, select: false },
            hasAccessToken: { type: Boolean },
            hasRefreshToken: { type: Boolean },
            expiresAt: { type: Date },
            grantedScope: { type: String },
            tokenIssuer: { type: String },
          },
          { _id: false }
        ),
        required: false,
      },
      apiKey: {
        type: new Schema(
          {
            headerName: { type: String, required: true },
            scheme: { type: String, enum: MCP_API_KEY_SCHEMES },
            valueEnc: { type: String, required: true, select: false },
            last4: { type: String, required: true },
          },
          { _id: false }
        ),
        required: false,
      },
    },
    status: { type: String, enum: MCP_CONNECTION_STATUSES, required: true },
    lastError: {
      type: new Schema(
        {
          code: { type: String, enum: MCP_CONNECTION_ERROR_CODES, required: true },
          message: { type: String, maxlength: MCP_CONNECTION_LIMITS.lastErrorMessageLength },
          at: Date,
          requiredScope: { type: String, maxlength: MCP_CONNECTION_LIMITS.requiredScopeLength },
        },
        { _id: false }
      ),
      required: false,
    },
    serverInfo: {
      type: new Schema(
        { name: serverInfoField, version: serverInfoField, protocolVersion: serverInfoField },
        { _id: false }
      ),
      required: false,
    },
    tools: {
      type: [McpConnectionToolSchema],
      default: [],
      validate: {
        validator: toolsWithinBounds,
        message: `At most ${MCP_CONNECTION_LIMITS.maxTools} tools and ${MCP_CONNECTION_LIMITS.maxToolsBytes} bytes`,
      },
    },
    toolsFingerprint: { type: String },
    toolsFetchedAt: { type: Date },
    toolsDropped: { type: Number },
    enabled: { type: Boolean, required: true, default: true },
    lastUsedAt: { type: Date },
    refreshLease: {
      type: new Schema(
        { holder: { type: String, required: true }, until: { type: Date, required: true } },
        { _id: false }
      ),
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Writes after create cannot break this: the generic writers refuse the owner fields and the token
// and lease writers filter on ownerType 'user'.
McpConnectionSchema.pre('validate', function () {
  const problem = mcpConnectionOwnerProblem(this.toObject());
  if (problem) throw new McpConnectionOwnerError(problem);
});

McpConnectionSchema.index({ ownerType: 1, ownerKey: 1, slug: 1 }, { unique: true, name: 'mcpconn_owner_slug' });
// Hot path of every chat turn and agent run, mirroring McpServer's mcp_user_enabled.
McpConnectionSchema.index({ userId: 1, enabled: 1 }, { name: 'mcpconn_user_enabled' });
McpConnectionSchema.index({ organizationId: 1, ownerType: 1 }, { name: 'mcpconn_org_owner_type' });
// Kill-switch and blocklist sweeps by host.
McpConnectionSchema.index({ urlHost: 1 }, { name: 'mcpconn_url_host' });
// Cascade when an org definition is removed.
McpConnectionSchema.index({ definitionId: 1 }, { sparse: true, name: 'mcpconn_definition' });

export interface IMcpConnectionModel extends Model<IMcpConnectionDocument & IMongoDocument> {}
export const McpConnection: IMcpConnectionModel =
  mongoose.models.McpConnection ?? model<IMcpConnectionDocument>('McpConnection', McpConnectionSchema);

const SUMMARY_PROJECTION = { 'tools.inputSchema': 0 };

const WITH_CREDENTIALS = MCP_CONNECTION_SECRET_PATHS.map(path => `+${path}`).join(' ');

/** `create` returns the inserted values, which include any secrets the caller just wrote. */
function stripSecrets<T extends IMcpConnectionDocument>(doc: T): T {
  for (const path of MCP_CONNECTION_SECRET_PATHS) {
    const keys = path.split('.');
    const leaf = keys.pop()!;
    const parent = keys.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc);
    if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[leaf];
  }
  return doc;
}

type ConnectionDoc = IMcpConnectionDocument & IMongoDocument;

const PROTECTED_FIELDS: ReadonlySet<string> = new Set(MCP_CONNECTION_PROTECTED_FIELDS);

/** Throws when `data` (a whole doc, a partial or dotted paths) or the `unset` option names a protected field. */
function assertNoProtectedFields(data: Record<string, unknown>, options?: Record<string, unknown>): void {
  const unset = Array.isArray(options?.unset) ? (options.unset as unknown[]) : [];
  for (const key of [...Object.keys(data), ...unset.filter((k): k is string => typeof k === 'string')]) {
    const root = key.split('.')[0]!;
    if (PROTECTED_FIELDS.has(root)) throw new McpConnectionProtectedFieldError(root);
  }
}

// The base repository does not run schema validators on its updates; force them here so a generic
// write cannot store a slug, status or enum value that `create` would have refused.
function withValidators(options?: RepositoryUpdateOptions<ConnectionDoc>): RepositoryUpdateOptions<ConnectionDoc> {
  return { ...options, runValidators: true };
}

function isOwnerSlugDuplicate(error: unknown): boolean {
  const mongoError = error as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  return (
    mongoError?.code === 11000 &&
    (Boolean(mongoError.keyPattern?.slug) || /mcpconn_owner_slug/.test(mongoError.message ?? ''))
  );
}

const OAUTH_TOKEN_FIELDS = ['refreshTokenEnc', 'expiresAt', 'grantedScope', 'tokenIssuer'] as const;

/**
 * The `$set`/`$unset` for a token write. `clearOmitted` names the optional fields an omission clears
 * rather than keeps (see McpOAuthTokenUpdate for which write clears what). The presence markers
 * move in the same write as the ciphertext they describe.
 */
function oauthTokenWrite(
  tokens: McpOAuthTokenUpdate,
  clearOmitted: readonly (typeof OAUTH_TOKEN_FIELDS)[number][]
): { $set: Record<string, unknown>; $unset: Record<string, 1> } {
  const $set: Record<string, unknown> = {
    'auth.oauth.accessTokenEnc': tokens.accessTokenEnc,
    'auth.oauth.hasAccessToken': true,
  };
  const $unset: Record<string, 1> = {};
  for (const field of OAUTH_TOKEN_FIELDS) {
    if (tokens[field] !== undefined) $set[`auth.oauth.${field}`] = tokens[field];
    else if (clearOmitted.includes(field)) $unset[`auth.oauth.${field}`] = 1;
  }
  if (tokens.refreshTokenEnc !== undefined) $set['auth.oauth.hasRefreshToken'] = true;
  else if (clearOmitted.includes('refreshTokenEnc')) $set['auth.oauth.hasRefreshToken'] = false;
  return { $set, $unset };
}

const TOOL_APPROVAL_MODES: ReadonlySet<string> = new Set(MCP_TOOL_APPROVAL_MODES);
const TOOL_STATES: ReadonlySet<string> = new Set(MCP_TOOL_STATES);

class McpConnectionRepository extends BaseRepository<ConnectionDoc> implements IMcpConnectionRepository {
  update(data: Partial<ConnectionDoc>, options?: RepositoryUpdateOptions<ConnectionDoc>): Promise<ConnectionDoc | null>;
  update(
    data: RepositoryPatch<ConnectionDoc>,
    options?: RepositoryUpdateOptions<ConnectionDoc>
  ): Promise<ConnectionDoc | null>;
  async update(data: Partial<ConnectionDoc>, options?: RepositoryUpdateOptions<ConnectionDoc>) {
    assertNoProtectedFields(data, options);
    return super.update(data, withValidators(options));
  }

  updateGuarded(
    data: Partial<ConnectionDoc>,
    options?: RepositoryUpdateOptions<ConnectionDoc>
  ): Promise<ConnectionDoc | null>;
  updateGuarded(
    data: RepositoryPatch<ConnectionDoc>,
    options?: RepositoryUpdateOptions<ConnectionDoc>
  ): Promise<ConnectionDoc | null>;
  async updateGuarded(data: Partial<ConnectionDoc>, options?: RepositoryUpdateOptions<ConnectionDoc>) {
    assertNoProtectedFields(data, options);
    return super.updateGuarded(data, withValidators(options));
  }

  async updateMany(
    filter: Record<string, unknown>,
    data: Partial<ConnectionDoc>,
    options?: RepositoryUpdateOptions<ConnectionDoc>
  ) {
    assertNoProtectedFields(data, options);
    return super.updateMany(filter, data, withValidators(options));
  }

  async create(data: Omit<IMcpConnectionDocument, 'id' | 'updatedAt' | 'createdAt'>) {
    const problem = mcpConnectionOwnerProblem(data);
    if (problem) throw new McpConnectionOwnerError(problem);
    const oauth = data.auth?.oauth;
    const withMarkers = oauth
      ? {
          ...data,
          auth: {
            ...data.auth,
            oauth: {
              ...oauth,
              hasAccessToken: Boolean(oauth.accessTokenEnc),
              hasRefreshToken: Boolean(oauth.refreshTokenEnc),
            },
          },
        }
      : data;
    try {
      return stripSecrets(await super.create(withMarkers));
    } catch (error) {
      if (isOwnerSlugDuplicate(error)) throw new McpConnectionSlugConflictError(data.slug);
      throw error;
    }
  }

  async findByIdForOwner(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return (await this.findOne({ _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey })) ?? null;
  }

  /** Owner-scoped so a request-supplied id can never read another owner's ciphertext. */
  async findByIdWithCredentials(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model
      .findOne({ _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey })
      .select(WITH_CREDENTIALS);
    return result?.toJSON() ?? null;
  }

  async listForUser(userId: string, options: { slugs?: string[] } = {}): Promise<IMcpConnectionDocument[]> {
    return this.find({
      userId,
      enabled: true,
      ownerType: 'user',
      status: 'connected',
      ...(options.slugs ? { slug: { $in: options.slugs } } : {}),
    });
  }

  async listAllForUser(userId: string): Promise<IMcpConnectionSummary[]> {
    return this.findSummaries({ userId, ownerType: 'user' });
  }

  async countForUser(userId: string): Promise<number> {
    return this.model.countDocuments({ userId, ownerType: 'user' });
  }

  async listForOrg(organizationId: string): Promise<IMcpConnectionSummary[]> {
    return this.findSummaries({ organizationId, ownerType: 'org' });
  }

  async findByUrlHost(urlHost: string): Promise<IMcpConnectionSummary[]> {
    return this.findSummaries({ urlHost: urlHost.toLowerCase() });
  }

  async listMemberConnections(
    organizationId: string,
    options: { urlHost?: string } = {}
  ): Promise<IMcpConnectionSummary[]> {
    return this.findSummaries({
      organizationId,
      ownerType: 'user',
      ...(options.urlHost ? { urlHost: options.urlHost.toLowerCase() } : {}),
    });
  }

  async findByDefinitionId(definitionId: string): Promise<IMcpConnectionSummary[]> {
    return this.findSummaries({ definitionId, ownerType: 'user' });
  }

  async deleteByDefinitionId(definitionId: string): Promise<number> {
    const result = await this.model.deleteMany({ definitionId, ownerType: 'user' });
    return result.deletedCount;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ ownerType: 'user', ownerKey: userId });
    return result.deletedCount;
  }

  /** Exclusive projection, so mongoose still applies every schema `select: false` on top of it. */
  private async findSummaries(filter: Record<string, unknown>): Promise<IMcpConnectionSummary[]> {
    const docs = await this.model.find(filter, SUMMARY_PROJECTION).sort({ createdAt: 1 });
    return docs.map(doc => doc.toObject() as IMcpConnectionSummary);
  }

  async rename(id: string, owner: McpConnectionOwner, displayName: string): Promise<IMcpConnectionDocument | null> {
    return this.updateForOwner(id, owner, { displayName });
  }

  async setEnabled(id: string, owner: McpConnectionOwner, enabled: boolean): Promise<IMcpConnectionDocument | null> {
    return this.updateForOwner(id, owner, { enabled });
  }

  /**
   * One `arrayFilters` update (identifier `t<i>` per tool name), so a partial failure cannot leave
   * half a review applied. Duplicate names collapse to the last entry: two filters resolving to the
   * same element would make the server reject the whole write as a path conflict.
   */
  async setToolSettings(
    id: string,
    owner: McpConnectionOwner,
    settings: McpToolSettingsUpdate[]
  ): Promise<IMcpConnectionDocument | null> {
    const byName = new Map<string, McpToolSettingsUpdate>();
    for (const entry of settings) {
      if (entry.approval !== undefined && !TOOL_APPROVAL_MODES.has(entry.approval)) {
        throw new Error(`Invalid tool approval mode: ${entry.approval}`);
      }
      if (entry.state !== undefined && !TOOL_STATES.has(entry.state)) {
        throw new Error(`Invalid tool state: ${entry.state}`);
      }
      byName.set(entry.name, { ...byName.get(entry.name), ...entry });
    }

    const set: Record<string, unknown> = {};
    const arrayFilters: Record<string, string>[] = [];
    for (const entry of byName.values()) {
      const fields = (['enabled', 'approval', 'state'] as const).filter(field => entry[field] !== undefined);
      if (fields.length === 0) continue;
      const ident = `t${arrayFilters.length}`;
      arrayFilters.push({ [`${ident}.name`]: entry.name });
      for (const field of fields) set[`tools.$[${ident}].${field}`] = entry[field];
    }
    if (arrayFilters.length === 0) return this.findByIdForOwner(id, owner);

    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey },
      { $set: set },
      { new: true, arrayFilters }
    );
    return result?.toJSON() ?? null;
  }

  async updateDiscovery(id: string, update: McpDiscoveryUpdate): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const set: Record<string, unknown> = {
      tools: update.tools,
      toolsFingerprint: update.fingerprint,
      toolsFetchedAt: new Date(),
      toolsDropped: update.dropped ?? 0,
    };
    if (update.detectedTransport !== undefined) set.detectedTransport = update.detectedTransport;
    // Untrusted server strings: truncate rather than fail the whole discovery on a long name.
    if (update.serverInfo !== undefined) {
      set.serverInfo = Object.fromEntries(
        Object.entries(update.serverInfo)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, (value as string).slice(0, MCP_CONNECTION_LIMITS.serverInfoFieldLength)])
      );
    }
    // `toolsFingerprint: null` also matches a document that never had one.
    const result = await this.model.findOneAndUpdate(
      { _id: id, toolsFingerprint: update.expectedFingerprint },
      { $set: set },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  private async updateForOwner(
    id: string,
    owner: McpConnectionOwner,
    set: Record<string, unknown>
  ): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey },
      { $set: set },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  setStatus(id: string, status: 'connected' | 'pending_auth'): Promise<IMcpConnectionDocument | null>;
  setStatus(
    id: string,
    status: 'error' | 'needs_reconnect',
    lastError: McpConnectionLastErrorInput
  ): Promise<IMcpConnectionDocument | null>;
  async setStatus(
    id: string,
    status: McpConnectionStatus,
    lastError?: McpConnectionLastErrorInput
  ): Promise<IMcpConnectionDocument | null> {
    if ((status === 'error' || status === 'needs_reconnect') && !lastError) {
      throw new Error(`setStatus(${status}) requires a lastError`);
    }
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const update =
      status === 'connected'
        ? { $set: { status }, $unset: { lastError: 1 } }
        : {
            $set: {
              status,
              ...(lastError
                ? {
                    lastError: {
                      ...lastError,
                      message: lastError.message.slice(0, MCP_CONNECTION_LIMITS.lastErrorMessageLength),
                      at: new Date(),
                    },
                  }
                : {}),
            },
          };
    const result = await this.model.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    return result?.toJSON() ?? null;
  }

  async completeRefresh(
    id: string,
    holder: string,
    tokens: McpOAuthTokenUpdate
  ): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const { $set, $unset } = oauthTokenWrite(tokens, ['expiresAt']);
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: 'user', 'auth.kind': 'oauth', 'refreshLease.holder': holder },
      { $set, $unset: { ...$unset, refreshLease: 1 } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async setInitialOAuthTokens(id: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    // Dropping the lease makes an in-flight refresh of the previous grant fail its holder check
    // instead of overwriting these tokens.
    const { $set, $unset } = oauthTokenWrite(tokens, OAUTH_TOKEN_FIELDS);
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: 'user', 'auth.kind': 'oauth' },
      { $set, $unset: { ...$unset, refreshLease: 1 } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async clearOAuthTokens(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey, 'auth.kind': 'oauth' },
      {
        $set: { 'auth.oauth.hasAccessToken': false, 'auth.oauth.hasRefreshToken': false },
        $unset: {
          'auth.oauth.accessTokenEnc': 1,
          'auth.oauth.refreshTokenEnc': 1,
          'auth.oauth.expiresAt': 1,
          'auth.oauth.grantedScope': 1,
          'auth.oauth.tokenIssuer': 1,
          refreshLease: 1,
        },
      },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async markUsed(id: string): Promise<void> {
    if (!mongoose.isObjectIdOrHexString(id)) return;
    await this.model.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
  }

  /**
   * Take the refresh lease when it is free or expired. Atomic, so of N concurrent callers exactly
   * one wins. Uses the app clock for `now` and `until`: a pipeline update could use `$$NOW`, but
   * DOCUMENTDB_COMPATIBILITY_NOTES.md does not establish pipeline-update support, so instances are
   * assumed NTP-synced and the 15 s TTL absorbs ordinary skew.
   */
  async acquireRefreshLease(
    id: string,
    holder: string,
    ttlMs: number = MCP_REFRESH_LEASE_TTL_MS
  ): Promise<McpRefreshLeaseResult> {
    if (!mongoose.isObjectIdOrHexString(id)) return { outcome: 'not_found' };
    const now = new Date();
    const result = await this.model
      .findOneAndUpdate(
        { _id: id, ownerType: 'user', $or: [{ refreshLease: null }, { 'refreshLease.until': { $lt: now } }] },
        { $set: { refreshLease: { holder, until: new Date(now.getTime() + ttlMs) } } },
        { new: true }
      )
      .select(WITH_CREDENTIALS);
    if (result) return { outcome: 'acquired', connection: result.toJSON() };

    const current = await this.model.findOne({ _id: id, ownerType: 'user' }, { refreshLease: 1 });
    if (!current) return { outcome: 'not_found' };
    return { outcome: 'held', holder: current.refreshLease?.holder, until: current.refreshLease?.until };
  }

  /** Releases only the caller's own lease, so a holder that overran its TTL cannot free a successor's. */
  async releaseRefreshLease(id: string, holder: string): Promise<boolean> {
    if (!mongoose.isObjectIdOrHexString(id)) return false;
    const result = await this.model.updateOne(
      { _id: id, 'refreshLease.holder': holder },
      { $unset: { refreshLease: 1 } }
    );
    return result.modifiedCount === 1;
  }

  async deleteForOwner(id: string, owner: McpConnectionOwner): Promise<boolean> {
    if (!mongoose.isObjectIdOrHexString(id)) return false;
    const result = await this.model.deleteOne({ _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey });
    return result.deletedCount === 1;
  }
}

export const mcpConnectionRepository = new McpConnectionRepository(McpConnection);

export default McpConnection;
