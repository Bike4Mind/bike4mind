import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError, type IMcpConnectionDocument } from '@bike4mind/common';
import { mcpConnectionRepository } from '@bike4mind/database';
import {
  cleanDiscoveredTools,
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
  const dropped = listed.dropped.length + refused.length;
  const owner = { ownerType: 'user' as const, ownerKey: userId };

  for (let attempt = 0; attempt < DISCOVERY_MAX_ATTEMPTS; attempt++) {
    const current = await mcpConnectionRepository.findByIdForOwner(connectionId, owner);
    if (!current) throw new NotFoundError('Connection not found');

    const merged = mergeDiscoveredTools(current.tools ?? [], cleaned);
    const stored = await mcpConnectionRepository.updateDiscovery(connectionId, {
      tools: merged.tools,
      fingerprint: computeMcpToolsFingerprint(merged.tools),
      expectedFingerprint: current.toolsFingerprint ?? null,
      expectedRevision: current.toolsRevision ?? 0,
      detectedTransport: listed.detectedTransport,
      serverInfo: {
        ...(listed.serverInfo ? { name: listed.serverInfo.name, version: listed.serverInfo.version } : {}),
        ...(listed.protocolVersion ? { protocolVersion: listed.protocolVersion } : {}),
      },
      dropped,
    });
    if (!stored) continue;

    if (refused.length > 0) {
      auditDiscovery(stored, userId, 'tools_dropped', {
        droppedCount: refused.length,
        reasons: [...new Set(refused.map(drop => drop.reason))],
        nameSha256s: refused.map(drop => drop.nameSha256),
      });
    }
    auditDiscovery(stored, userId, 'tools_discovered', {
      toolCount: merged.tools.length,
      droppedCount: dropped,
      changedCount: merged.added.length + merged.changed.length,
    });
    const connection =
      stored.status === 'connected'
        ? stored
        : ((await mcpConnectionRepository.setStatus(connectionId, 'connected')) ?? stored);
    return { connection, added: merged.added, changed: merged.changed, removed: merged.removed, dropped };
  }
  throw new ConflictError('The tools changed while they were being refreshed; try again', {
    code: 'discovery_conflict',
  });
}
