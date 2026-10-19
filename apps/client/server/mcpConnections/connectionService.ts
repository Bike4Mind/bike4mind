import { randomUUID } from 'crypto';
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  McpConnectionSlugConflictError,
  NotFoundError,
  isValidMcpConnectionSlug,
  toMcpApiKeyLast4,
  toMcpConnectionPublic,
  type IMcpConnectionAuth,
  type IMcpConnectionDocument,
  type IMcpConnectionPublic,
  type IMcpConnectionSummary,
  type McpConnectionOwner,
  type McpToolSettingsUpdate,
} from '@bike4mind/common';
import { mcpConnectionRepository } from '@bike4mind/database';
import { RemoteMcpError } from '@bike4mind/mcp/remote';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { encryptToken } from '@server/security/tokenEncryption';
import type {
  McpConnectionApiKeyBody,
  McpConnectionCreateBody,
  McpConnectionPatchBody,
} from '@server/validators/mcpConnectionValidators';
import { prepareConnectionUrl } from './connectionUrl';
import { evaluateConnectionPolicy, type CustomMcpContext } from './customMcpAccess';
import { discoverConnectionTools, type DiscoveryOutcome } from './discovery';
import { describeRemoteMcpError, type InvokeRemoteMcpOptions } from './invokeRemoteMcp';

/**
 * The custom MCP connection operations behind pages/api/mcp-connections/**. Every operation is
 * owner-scoped to the calling user (user connections only; org definitions come with the org
 * admin work): another user's id reads as not found.
 */

export interface ConnectionActor {
  id: string;
  /** The selected org pointer; stamped on a new connection only when the user is a member. */
  organizationId?: string | null;
}

const userOwner = (userId: string): McpConnectionOwner => ({ ownerType: 'user', ownerKey: userId });

function audit(
  actor: ConnectionActor,
  action: string,
  connection: Pick<IMcpConnectionDocument, 'id' | 'urlHost' | 'slug'>,
  extra: Record<string, unknown> = {}
): IntegrationAuditLogger {
  return IntegrationAuditLogger.create({
    entityType: 'mcp_connection',
    integrationName: 'custom_mcp',
    action,
    requestId: randomUUID().split('-')[0]!,
    userId: actor.id,
    metadata: { connectionId: connection.id, host: connection.urlHost, slug: connection.slug, ...extra },
  });
}

/** The client view with the status the current policy implies (`blocked_by_policy` when it denies). */
export function toPublicView(
  context: CustomMcpContext,
  connection: IMcpConnectionDocument | IMcpConnectionSummary
): IMcpConnectionPublic {
  return toMcpConnectionPublic(
    connection,
    evaluateConnectionPolicy(context, {
      urlHost: connection.urlHost,
      authKind: connection.auth?.kind ?? 'none',
      url: connection.displayUrl,
    })
  );
}

const SLUG_MAX = 20;
const SLUG_SUFFIX_ATTEMPTS = 9;

/**
 * A slug from the display name, else the host's first label: lowercase ASCII, single underscores,
 * a leading letter, room left for a `_N` suffix. Reserved or empty results fall back.
 */
export function deriveMcpConnectionSlug(displayName: string, urlHost: string): string {
  const fromText = (text: string): string => {
    let slug = text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^[^a-z]+/, '')
      .slice(0, SLUG_MAX - 3)
      .replace(/_+$/, '');
    if (slug.length === 1) slug = `${slug}_mcp`;
    return slug;
  };
  for (const candidate of [fromText(displayName), fromText(urlHost.split('.')[0] ?? '')]) {
    if (isValidMcpConnectionSlug(candidate)) return candidate;
    const custom = `${candidate}_custom`.slice(0, SLUG_MAX - 3).replace(/_+$/, '');
    if (candidate && isValidMcpConnectionSlug(custom)) return custom;
  }
  return 'connector';
}

function buildAuth(body: McpConnectionCreateBody['auth']): IMcpConnectionAuth {
  if (body.kind === 'none') return { kind: 'none' };
  const valueEnc = encryptToken(body.value);
  if (!valueEnc) throw new Error('API key encryption returned nothing');
  return {
    kind: 'api_key',
    apiKey: { headerName: body.headerName, scheme: body.scheme, valueEnc, last4: toMcpApiKeyLast4(body.value) },
  };
}

/** Probe and discover; a remote failure is already recorded on the connection, so it is not an error here. */
async function probe(
  actor: ConnectionActor,
  connection: IMcpConnectionDocument,
  options: InvokeRemoteMcpOptions
): Promise<DiscoveryOutcome | undefined> {
  const probeAudit = audit(actor, 'probe_result', connection);
  try {
    const outcome = await discoverConnectionTools(connection.id, actor.id, options);
    probeAudit.success({ toolCount: outcome.connection.tools.length });
    return outcome;
  } catch (error) {
    if (error instanceof RemoteMcpError) {
      probeAudit.failure(error.code);
      return undefined;
    }
    probeAudit.failure('internal_error');
    throw error;
  }
}

/**
 * Validates, policy-checks and stores a connection within the user's cap, then probes it: a 200 is
 * `connected` with its tools pending review, a 401 on an unauthenticated connection is
 * `pending_auth` with the challenge kept for OAuth, anything else is `error` with a readable reason.
 */
export async function createUserConnection(
  actor: ConnectionActor,
  context: CustomMcpContext,
  body: McpConnectionCreateBody,
  options: InvokeRemoteMcpOptions = {}
): Promise<IMcpConnectionPublic> {
  const prepared = prepareConnectionUrl(body.url, context.network);
  const verdict = evaluateConnectionPolicy(context, {
    urlHost: prepared.urlHost,
    authKind: body.auth.kind,
    url: prepared.url,
  });
  if (!verdict.allowed) {
    throw new ForbiddenError(verdict.message, { code: 'policy_blocked', reason: verdict.reason });
  }

  const organizationId =
    actor.organizationId && context.organizationIds.includes(actor.organizationId) ? actor.organizationId : undefined;
  const base = {
    ownerType: 'user' as const,
    ownerKey: actor.id,
    userId: actor.id,
    ...(organizationId ? { organizationId } : {}),
    displayName: body.displayName,
    urlEnc: prepared.urlEnc,
    displayUrl: prepared.displayUrl,
    urlHost: prepared.urlHost,
    transport: body.transport,
    auth: buildAuth(body.auth),
    status: 'pending_auth' as const,
    tools: [],
    enabled: true,
  };

  // An explicit slug is the user's choice and conflicts with a 409; a derived one takes a suffix.
  const derived = deriveMcpConnectionSlug(body.displayName, prepared.urlHost);
  const candidates = body.slug
    ? [body.slug]
    : [derived, ...Array.from({ length: SLUG_SUFFIX_ATTEMPTS - 1 }, (_, i) => `${derived}_${i + 2}`)];
  let created: IMcpConnectionDocument | undefined;
  for (const slug of candidates) {
    try {
      created = await mcpConnectionRepository.createWithinUserCap({ ...base, slug }, context.maxConnectionsPerUser);
      break;
    } catch (error) {
      if (!(error instanceof McpConnectionSlugConflictError) || slug === candidates[candidates.length - 1]) throw error;
    }
  }
  if (!created) throw new ConflictError('Could not pick a free slug', { code: 'slug_conflict' });

  audit(actor, 'connection_created', created, { authKind: body.auth.kind }).success();
  await probe(actor, created, { ...options, context });
  const reloaded = await mcpConnectionRepository.findByIdForOwner(created.id, userOwner(actor.id));
  if (!reloaded) throw new NotFoundError('Connection not found');
  return toPublicView(context, reloaded);
}

export async function listUserConnections(
  actor: ConnectionActor,
  context: CustomMcpContext
): Promise<IMcpConnectionPublic[]> {
  const connections = await mcpConnectionRepository.listAllForUser(actor.id);
  return connections.map(connection => toPublicView(context, connection));
}

export async function getUserConnection(
  actor: ConnectionActor,
  context: CustomMcpContext,
  id: string
): Promise<IMcpConnectionPublic> {
  const connection = await mcpConnectionRepository.findByIdForOwner(id, userOwner(actor.id));
  if (!connection) throw new NotFoundError('Connection not found');
  return toPublicView(context, connection);
}

/**
 * Rename, enable or disable, and save a tool review, in one write. Enabling a tool that is pending
 * review counts as reviewing it (it becomes `active`) unless the entry says otherwise. Each tool
 * entry names the `versionHash` it reviewed: an unknown tool is a 400 and a tool that changed
 * since is a 409, and either way nothing is written.
 */
export async function updateUserConnection(
  actor: ConnectionActor,
  context: CustomMcpContext,
  id: string,
  body: McpConnectionPatchBody
): Promise<IMcpConnectionPublic> {
  const owner = userOwner(actor.id);
  const current = await mcpConnectionRepository.findByIdForOwner(id, owner);
  if (!current) throw new NotFoundError('Connection not found');

  let settings: McpToolSettingsUpdate[] | undefined;
  if (body.tools !== undefined) {
    const known = new Set((current.tools ?? []).map(tool => tool.name));
    const unknown = body.tools.filter(entry => !known.has(entry.name)).length;
    if (unknown > 0) {
      throw new BadRequestError(`${unknown} of the reviewed tools are not on this connection`, {
        code: 'unknown_tool',
      });
    }
    settings = body.tools.map(entry =>
      entry.enabled === true && entry.state === undefined ? { ...entry, state: 'active' } : entry
    );
  }

  const connection = await mcpConnectionRepository.updateSettings(id, owner, {
    ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(settings ? { tools: settings } : {}),
  });
  if (!connection) throw new NotFoundError('Connection not found');
  if (settings) audit(actor, 'tool_review_saved', connection, { toolCount: settings.length }).success();
  return toPublicView(context, connection);
}

export interface RefreshResult {
  connection: IMcpConnectionPublic;
  discovery: { added: string[]; changed: string[]; removed: string[]; dropped: number };
}

export async function refreshUserConnectionTools(
  actor: ConnectionActor,
  context: CustomMcpContext,
  id: string,
  options: InvokeRemoteMcpOptions = {}
): Promise<RefreshResult> {
  const connection = await mcpConnectionRepository.findByIdForOwner(id, userOwner(actor.id));
  if (!connection) throw new NotFoundError('Connection not found');
  let outcome: DiscoveryOutcome;
  try {
    outcome = await discoverConnectionTools(id, actor.id, { ...options, context });
  } catch (error) {
    // Already recorded on the connection; the caller re-reads it for the new status.
    if (error instanceof RemoteMcpError) {
      throw new BadGatewayError(describeRemoteMcpError(error, connection.auth.kind), { code: error.code });
    }
    throw error;
  }
  const { added, changed, removed, dropped } = outcome;
  return { connection: toPublicView(context, outcome.connection), discovery: { added, changed, removed, dropped } };
}

/** Replaces the API key (write-only; only `last4` comes back), then re-probes with it. */
export async function rotateUserConnectionApiKey(
  actor: ConnectionActor,
  context: CustomMcpContext,
  id: string,
  body: McpConnectionApiKeyBody,
  options: InvokeRemoteMcpOptions = {}
): Promise<IMcpConnectionPublic> {
  const owner = userOwner(actor.id);
  const connection = await mcpConnectionRepository.findByIdForOwner(id, owner);
  if (!connection) throw new NotFoundError('Connection not found');
  const current = connection.auth.apiKey;
  if (connection.auth.kind !== 'api_key' || !current) {
    throw new ConflictError('This connection does not use an API key', { code: 'not_api_key' });
  }
  const valueEnc = encryptToken(body.value);
  if (!valueEnc) throw new BadRequestError('API key is required');
  const rotated = await mcpConnectionRepository.setApiKey(id, owner, {
    headerName: body.headerName ?? current.headerName,
    scheme: body.scheme ?? current.scheme ?? 'Bearer',
    valueEnc,
    last4: toMcpApiKeyLast4(body.value),
  });
  if (!rotated) throw new NotFoundError('Connection not found');
  audit(actor, 'api_key_rotated', rotated).success();

  await probe(actor, rotated, { ...options, context });
  const reloaded = await mcpConnectionRepository.findByIdForOwner(id, owner);
  if (!reloaded) throw new NotFoundError('Connection not found');
  return toPublicView(context, reloaded);
}

/**
 * SEAM (OAuth): revoke the refresh token, then the access token, at the advertised
 * `revocation_endpoint` (RFC 7009, best effort, logged) before the record goes. Nothing to revoke
 * for `none` and `api_key` connections; an API key is the user's to revoke at the vendor.
 */
async function revokeRemoteGrant(connection: IMcpConnectionDocument): Promise<void> {
  if (connection.auth.kind !== 'oauth') return;
}

/** Owner-scoped delete; open even with connectors switched off, so a user can always clean up. */
export async function deleteUserConnection(actor: ConnectionActor, id: string): Promise<void> {
  const owner = userOwner(actor.id);
  const connection = await mcpConnectionRepository.findByIdForOwner(id, owner);
  if (!connection) throw new NotFoundError('Connection not found');
  await revokeRemoteGrant(connection);
  if (!(await mcpConnectionRepository.deleteForOwner(id, owner))) throw new NotFoundError('Connection not found');
  audit(actor, 'disconnected', connection).success();
}
