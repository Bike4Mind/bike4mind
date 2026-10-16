import {
  IMcpConnectionDocument,
  IMcpConnectionRepository,
  IMcpConnectionTool,
  IMcpConnectionLastError,
  IMongoDocument,
  McpConnectionOwner,
  McpConnectionStatus,
  McpOAuthTokenUpdate,
  MCP_API_KEY_SCHEMES,
  MCP_CONNECTION_AUTH_KINDS,
  MCP_CONNECTION_OWNER_TYPES,
  MCP_CONNECTION_SECRET_PATHS,
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
    slug: { type: String, required: true },
    displayName: { type: String, required: true },
    url: { type: String, required: true },
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
  const oauth = doc.auth?.oauth;
  if (oauth) {
    delete oauth.manualClientIdEnc;
    delete oauth.manualClientSecretEnc;
    delete oauth.accessTokenEnc;
    delete oauth.refreshTokenEnc;
  }
  if (doc.auth?.apiKey) delete (doc.auth.apiKey as { valueEnc?: string }).valueEnc;
  return doc;
}

class McpConnectionRepository
  extends BaseRepository<IMcpConnectionDocument & IMongoDocument>
  implements IMcpConnectionRepository
{
  async create(data: Omit<IMcpConnectionDocument, 'id' | 'updatedAt' | 'createdAt'>) {
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

  async updateTools(
    id: string,
    tools: IMcpConnectionTool[],
    fingerprint: string
  ): Promise<IMcpConnectionDocument | null> {
    const result = await this.model.findByIdAndUpdate(
      id,
      { $set: { tools, toolsFingerprint: fingerprint, toolsFetchedAt: new Date() } },
      { new: true }
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

  async updateOAuthTokens(id: string, tokens: McpOAuthTokenUpdate): Promise<IMcpConnectionDocument | null> {
    const set: Record<string, unknown> = { 'auth.oauth.accessTokenEnc': tokens.accessTokenEnc };
    if (tokens.refreshTokenEnc !== undefined) set['auth.oauth.refreshTokenEnc'] = tokens.refreshTokenEnc;
    if (tokens.expiresAt !== undefined) set['auth.oauth.expiresAt'] = tokens.expiresAt;
    if (tokens.grantedScope !== undefined) set['auth.oauth.grantedScope'] = tokens.grantedScope;
    if (tokens.tokenIssuer !== undefined) set['auth.oauth.tokenIssuer'] = tokens.tokenIssuer;
    const result = await this.model.findByIdAndUpdate(id, { $set: set }, { new: true });
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
        { _id: id, $or: [{ refreshLease: null }, { 'refreshLease.until': { $lt: now } }] },
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
