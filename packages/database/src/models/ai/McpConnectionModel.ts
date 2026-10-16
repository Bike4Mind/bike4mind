import {
  IMcpConnectionDocument,
  IMcpConnectionRepository,
  IMcpConnectionTool,
  IMcpConnectionLastError,
  IMongoDocument,
  McpConnectionOwner,
  McpConnectionProtectedFieldError,
  McpConnectionStatus,
  McpDiscoveryUpdate,
  McpOAuthTokenUpdate,
  McpToolSettingsUpdate,
  MCP_CONNECTION_PROTECTED_FIELDS,
  mcpConnectionOwnerProblem,
  RepositoryPatch,
  RepositoryUpdateOptions,
  MCP_API_KEY_SCHEMES,
  MCP_CONNECTION_AUTH_KINDS,
  MCP_CONNECTION_OWNER_TYPES,
  MCP_CONNECTION_SECRET_PATHS,
  MCP_CONNECTION_SLUG_PATTERN,
  MCP_CONNECTION_STATUSES,
  MCP_CONNECTION_TRANSPORTS,
  MCP_OAUTH_CLIENT_MODES,
  MCP_TOOL_APPROVAL_MODES,
  MCP_TOOL_STATES,
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
    name: { type: String, required: true },
    title: { type: String },
    description: { type: String, default: '' },
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

// Secrets are `select: false` (see MCP_CONNECTION_SECRET_PATHS); credential reads opt back in.
const McpConnectionSchema = new Schema<IMcpConnectionDocument>(
  {
    ownerType: { type: String, enum: MCP_CONNECTION_OWNER_TYPES, required: true },
    ownerKey: { type: String, required: true },
    userId: { type: String, required: true },
    organizationId: { type: String },
    definitionId: { type: String },
    presetId: { type: String },
    slug: { type: String, required: true, match: MCP_CONNECTION_SLUG_PATTERN },
    displayName: { type: String, required: true },
    urlEnc: { type: String, required: true, select: false },
    displayUrl: { type: String, required: true },
    urlHost: { type: String, required: true },
    transport: { type: String, enum: MCP_CONNECTION_TRANSPORTS, default: 'auto' },
    detectedTransport: { type: String, enum: ['streamable-http', 'sse'] },
    auth: {
      kind: { type: String, enum: MCP_CONNECTION_AUTH_KINDS, required: true },
      oauth: {
        type: new Schema(
          {
            resource: { type: String, required: true },
            resourceMetadataUrl: { type: String },
            issuer: { type: String, required: true },
            authorizationServerUrl: { type: String, required: true },
            scopes: { type: [String], default: [] },
            clientMode: { type: String, enum: MCP_OAUTH_CLIENT_MODES, required: true },
            clientRegistrationId: { type: String },
            manualClientIdEnc: { type: String, select: false },
            manualClientSecretEnc: { type: String, select: false },
            accessTokenEnc: { type: String, select: false },
            refreshTokenEnc: { type: String, select: false },
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
      type: new Schema({ code: String, message: String, at: Date }, { _id: false }),
      required: false,
    },
    serverInfo: {
      type: new Schema({ name: String, version: String, protocolVersion: String }, { _id: false }),
      required: false,
    },
    tools: { type: [McpConnectionToolSchema], default: [] },
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

function oauthTokenSet(tokens: McpOAuthTokenUpdate): Record<string, unknown> {
  const set: Record<string, unknown> = { 'auth.oauth.accessTokenEnc': tokens.accessTokenEnc };
  if (tokens.refreshTokenEnc !== undefined) set['auth.oauth.refreshTokenEnc'] = tokens.refreshTokenEnc;
  if (tokens.expiresAt !== undefined) set['auth.oauth.expiresAt'] = tokens.expiresAt;
  if (tokens.grantedScope !== undefined) set['auth.oauth.grantedScope'] = tokens.grantedScope;
  if (tokens.tokenIssuer !== undefined) set['auth.oauth.tokenIssuer'] = tokens.tokenIssuer;
  return set;
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
    return super.update(data, options);
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
    return super.updateGuarded(data, options);
  }

  async updateMany(
    filter: Record<string, unknown>,
    data: Partial<ConnectionDoc>,
    options?: RepositoryUpdateOptions<ConnectionDoc>
  ) {
    assertNoProtectedFields(data, options);
    return super.updateMany(filter, data, options);
  }

  async create(data: Omit<IMcpConnectionDocument, 'id' | 'updatedAt' | 'createdAt'>) {
    const problem = mcpConnectionOwnerProblem(data);
    if (problem) throw new McpConnectionOwnerError(problem);
    return stripSecrets(await super.create(data));
  }

  async findByIdForOwner(id: string, owner: McpConnectionOwner): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return (await this.findOne({ _id: id, ownerType: owner.ownerType, ownerKey: owner.ownerKey })) ?? null;
  }

  async findByIdWithCredentials(id: string): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findById(id).select(WITH_CREDENTIALS);
    return result?.toJSON() ?? null;
  }

  async listForUser(userId: string): Promise<IMcpConnectionDocument[]> {
    return this.find({ userId, enabled: true, ownerType: 'user', status: 'connected' });
  }

  async listAllForUser(userId: string): Promise<IMcpConnectionDocument[]> {
    return this.find({ userId, ownerType: 'user' }, { sort: { createdAt: 1 } });
  }

  async countForUser(userId: string): Promise<number> {
    return this.model.countDocuments({ userId, ownerType: 'user' });
  }

  async listForOrg(organizationId: string): Promise<IMcpConnectionDocument[]> {
    return this.find({ organizationId, ownerType: 'org' }, { sort: { createdAt: 1 } });
  }

  async findByUrlHost(urlHost: string): Promise<IMcpConnectionDocument[]> {
    return this.find({ urlHost: urlHost.toLowerCase() });
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
    if (update.serverInfo !== undefined) set.serverInfo = update.serverInfo;
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

  /** `connected` clears `lastError`; any other status records it when given. */
  async setStatus(
    id: string,
    status: McpConnectionStatus,
    lastError?: Omit<IMcpConnectionLastError, 'at'>
  ): Promise<IMcpConnectionDocument | null> {
    const update =
      status === 'connected'
        ? { $set: { status }, $unset: { lastError: 1 } }
        : { $set: { status, ...(lastError ? { lastError: { ...lastError, at: new Date() } } : {}) } };
    const result = await this.model.findByIdAndUpdate(id, update, { new: true });
    return result?.toJSON() ?? null;
  }

  async completeRefresh(
    id: string,
    holder: string,
    tokens: McpOAuthTokenUpdate
  ): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: 'user', 'auth.kind': 'oauth', 'refreshLease.holder': holder },
      { $set: oauthTokenSet(tokens), $unset: { refreshLease: 1 } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async setInitialOAuthTokens(id: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const result = await this.model.findOneAndUpdate(
      { _id: id, ownerType: 'user', 'auth.kind': 'oauth' },
      { $set: oauthTokenSet(tokens) },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async markUsed(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
  }

  /**
   * Take the refresh lease when it is free or expired. Atomic, so of N concurrent callers exactly
   * one wins; the losers get null and should re-read the record until the winner has stored the
   * rotated token. Resolves with credentials, because the winner is about to spend the refresh token.
   */
  async acquireRefreshLease(
    id: string,
    holder: string,
    ttlMs: number = MCP_REFRESH_LEASE_TTL_MS
  ): Promise<IMcpConnectionDocument | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const now = new Date();
    const result = await this.model
      .findOneAndUpdate(
        { _id: id, ownerType: 'user', $or: [{ refreshLease: null }, { 'refreshLease.until': { $lt: now } }] },
        { $set: { refreshLease: { holder, until: new Date(now.getTime() + ttlMs) } } },
        { new: true }
      )
      .select(WITH_CREDENTIALS);
    return result?.toJSON() ?? null;
  }

  /** Releases only the caller's own lease, so a holder that overran its TTL cannot free a successor's. */
  async releaseRefreshLease(id: string, holder: string): Promise<boolean> {
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
