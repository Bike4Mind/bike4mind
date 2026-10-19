import { createHash, randomUUID } from 'crypto';
import {
  ConflictError,
  MCP_CONNECTION_LIMITS,
  NotFoundError,
  type IMcpConnectionDocument,
  type IMcpConnectionServerInfo,
  type IMcpConnectionTool,
} from '@bike4mind/common';
import { mcpConnectionRepository, measureStoredMcpToolsBytes } from '@bike4mind/database';
import type { RemoteMcpListToolsResult } from '@bike4mind/mcp/remote';
import {
  cleanDiscoveredTools,
  cleanMcpToolText,
  computeMcpToolsFingerprint,
  mergeDiscoveredTools,
} from '@bike4mind/server-utils/mcpConnections/toolDiscovery';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { invokeRemoteMcp, type InvokeRemoteMcpOptions } from './invokeRemoteMcp';

/** Compare-and-set attempts before giving up; each loss means a concurrent review or discovery. */
export const DISCOVERY_MAX_ATTEMPTS = 3;

export interface DiscoveryOutcome {
  connection: IMcpConnectionDocument;
  added: string[];
  changed: string[];
  removed: string[];
  dropped: number;
}

function auditDiscovery(
  connection: IMcpConnectionDocument,
  userId: string,
  action: 'tools_discovered' | 'tools_dropped',
  extra: Record<string, unknown>
): void {
  IntegrationAuditLogger.create({
    entityType: 'mcp_connection',
    integrationName: 'custom_mcp',
    action,
    requestId: randomUUID().split('-')[0]!,
    userId,
    metadata: { connectionId: connection.id, host: connection.urlHost, slug: connection.slug, ...extra },
  }).success();
}

/** The longest prefix of `tools` (server order) whose stored form fits `maxToolsBytes`. */
function fitToolsWithinStorageBound(tools: IMcpConnectionTool[]): IMcpConnectionTool[] {
  // A JSON array is its brackets, its items and a comma between each pair.
  const sizes = tools.map(tool => measureStoredMcpToolsBytes([tool]) - 2);
  let count = tools.length;
  let total = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(count - 1, 0);
  while (count > 0 && total > MCP_CONNECTION_LIMITS.maxToolsBytes) {
    count -= 1;
    total -= sizes[count]! + (count > 0 ? 1 : 0);
  }
  return count === tools.length ? tools : tools.slice(0, count);
}

function cleanServerInfo(listed: RemoteMcpListToolsResult): IMcpConnectionServerInfo {
  const clean = (value: string | undefined) =>
    typeof value === 'string' ? cleanMcpToolText(value, MCP_CONNECTION_LIMITS.serverInfoFieldLength) : '';
  const name = clean(listed.serverInfo?.name);
  const version = clean(listed.serverInfo?.version);
  const protocolVersion = clean(listed.protocolVersion);
  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
  };
}

const nameSha256 = (name: string) => createHash('sha256').update(name, 'utf8').digest('hex');

/**
 * Fetches the server's tools through the dispatcher, cleans them, merges them into the stored list
 * (new or changed tools wait for review) and stores the result with the fingerprint-and-revision
 * compare-and-set. A loss re-reads and re-merges, so a review saved mid-discovery is kept. Marks
 * the connection connected. Remote failures propagate, already recorded on the connection.
 */
export async function discoverConnectionTools(
  connectionId: string,
  userId: string,
  options: InvokeRemoteMcpOptions = {}
): Promise<DiscoveryOutcome> {
  const listed = await invokeRemoteMcp({ action: 'listTools', connectionId, userId }, options);
  const { tools: cleaned, dropped: refused } = cleanDiscoveredTools(listed.tools);
  const serverInfo = cleanServerInfo(listed);
  const owner = { ownerType: 'user' as const, ownerKey: userId };

  for (let attempt = 0; attempt < DISCOVERY_MAX_ATTEMPTS; attempt++) {
    const current = await mcpConnectionRepository.findByIdForOwner(connectionId, owner);
    if (!current) throw new NotFoundError('Connection not found');

    const merged = mergeDiscoveredTools(current.tools ?? [], cleaned);
    const tools = fitToolsWithinStorageBound(merged.tools);
    const kept = new Set(tools.map(tool => tool.name));
    const overflow = merged.tools
      .slice(tools.length)
      .map(tool => ({ reason: 'storage_cap', nameSha256: nameSha256(tool.name) }));
    const added = merged.added.filter(name => kept.has(name));
    const changed = merged.changed.filter(name => kept.has(name));
    const dropped = listed.dropped.length + refused.length + overflow.length;
    const stored = await mcpConnectionRepository.updateDiscovery(connectionId, {
      tools,
      fingerprint: computeMcpToolsFingerprint(tools),
      expectedFingerprint: current.toolsFingerprint ?? null,
      expectedRevision: current.toolsRevision ?? 0,
      detectedTransport: listed.detectedTransport,
      serverInfo,
      dropped,
    });
    if (!stored) continue;

    const refusedHere = [...refused, ...overflow];
    if (refusedHere.length > 0) {
      auditDiscovery(stored, userId, 'tools_dropped', {
        droppedCount: refusedHere.length,
        reasons: [...new Set(refusedHere.map(drop => drop.reason))],
        nameSha256s: refusedHere.map(drop => drop.nameSha256),
      });
    }
    auditDiscovery(stored, userId, 'tools_discovered', {
      toolCount: tools.length,
      droppedCount: dropped,
      changedCount: added.length + changed.length,
    });
    const connection =
      stored.status === 'connected'
        ? stored
        : ((await mcpConnectionRepository.setStatus(connectionId, 'connected')) ?? stored);
    return { connection, added, changed, removed: merged.removed, dropped };
  }
  throw new ConflictError('The tools changed while they were being refreshed; try again', {
    code: 'discovery_conflict',
  });
}
