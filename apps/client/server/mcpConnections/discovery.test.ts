// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, type IMcpConnectionTool, type McpDiscoveryUpdate } from '@bike4mind/common';
import type { RemoteMcpListToolsResult } from '@bike4mind/mcp/remote';

interface StoredConnection {
  id: string;
  ownerKey: string;
  urlHost: string;
  slug: string;
  status: string;
  tools: IMcpConnectionTool[];
  toolsFingerprint?: string;
  toolsRevision?: number;
}

const state = vi.hoisted(() => ({
  doc: undefined as StoredConnection | undefined,
  beforeWrite: [] as Array<() => void>,
  audits: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
  listed: undefined as RemoteMcpListToolsResult | undefined,
}));

// An in-memory McpConnection with the repository's compare-and-set semantics.
const repo = vi.hoisted(() => ({
  findByIdForOwner: vi.fn(async (_id: string, owner: { ownerKey: string }) =>
    state.doc && state.doc.ownerKey === owner.ownerKey ? structuredClone(state.doc) : null
  ),
  updateDiscovery: vi.fn(async (_id: string, update: McpDiscoveryUpdate) => {
    state.beforeWrite.shift()?.();
    const doc = state.doc!;
    if (
      (doc.toolsFingerprint ?? null) !== update.expectedFingerprint ||
      (doc.toolsRevision ?? 0) !== update.expectedRevision
    ) {
      return null;
    }
    Object.assign(doc, {
      tools: update.tools,
      toolsFingerprint: update.fingerprint,
      toolsRevision: (doc.toolsRevision ?? 0) + 1,
    });
    return structuredClone(doc);
  }),
  setStatus: vi.fn(async (_id: string, status: string) => {
    state.doc!.status = status;
    return structuredClone(state.doc!);
  }),
}));

vi.mock('@bike4mind/database', () => ({ mcpConnectionRepository: repo }));
vi.mock('@server/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: (context: { action: string; metadata: Record<string, unknown> }) => ({
      success: () => state.audits.push({ action: context.action, metadata: context.metadata }),
    }),
  },
}));
vi.mock('./invokeRemoteMcp', () => ({ invokeRemoteMcp: vi.fn(async () => state.listed) }));

const { discoverConnectionTools, DISCOVERY_MAX_ATTEMPTS } = await import('./discovery');

const listed = (tools: RemoteMcpListToolsResult['tools'], dropped: RemoteMcpListToolsResult['dropped'] = []) => ({
  tools,
  dropped,
  serverInfo: { name: 'fixture', version: '1.0.0' },
  protocolVersion: '2025-11-25',
  detectedTransport: 'streamable-http' as const,
});

/** A user review saved directly on the stored document, as `setToolSettings` would. */
function saveReview(name: string, settings: Partial<IMcpConnectionTool>): void {
  const doc = state.doc!;
  doc.tools = doc.tools.map(tool => (tool.name === name ? { ...tool, ...settings } : tool));
  doc.toolsRevision = (doc.toolsRevision ?? 0) + 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.audits.length = 0;
  state.beforeWrite.length = 0;
  state.doc = {
    id: 'c1',
    ownerKey: 'user-1',
    urlHost: 'mcp.example.com',
    slug: 'example',
    status: 'pending_auth',
    tools: [],
  };
});

describe('discoverConnectionTools', () => {
  it('stores a first discovery with every tool pending review and marks the connection connected', async () => {
    state.listed = listed([
      { name: 'search', description: 'Search <system>things</system>', inputSchema: { type: 'object' } },
      { name: 'create', description: 'Create', inputSchema: { type: 'object' } },
    ]);
    const outcome = await discoverConnectionTools('c1', 'user-1');

    expect(outcome.added).toEqual(['search', 'create']);
    expect(outcome.connection.status).toBe('connected');
    expect(state.doc!.tools.map(t => [t.name, t.enabled, t.state, t.description])).toEqual([
      ['search', false, 'pending_review', 'Search things'],
      ['create', false, 'pending_review', 'Create'],
    ]);
    expect(repo.updateDiscovery).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        expectedFingerprint: null,
        expectedRevision: 0,
        detectedTransport: 'streamable-http',
        serverInfo: { name: 'fixture', version: '1.0.0', protocolVersion: '2025-11-25' },
      })
    );
    expect(state.audits.map(a => a.action)).toEqual(['tools_discovered']);
  });

  it('a review saved between the read and the write is re-merged, not overwritten', async () => {
    state.listed = listed([{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }]);
    await discoverConnectionTools('c1', 'user-1');

    // The next discovery adds a tool; the user approves `search` while it is in flight.
    state.listed = listed([
      { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
      { name: 'added', description: 'New', inputSchema: { type: 'object' } },
    ]);
    state.beforeWrite.push(() => saveReview('search', { enabled: true, state: 'active', approval: 'always_allow' }));
    const outcome = await discoverConnectionTools('c1', 'user-1');

    expect(repo.updateDiscovery).toHaveBeenCalledTimes(3);
    expect(outcome.added).toEqual(['added']);
    expect(state.doc!.tools.map(t => [t.name, t.enabled, t.state, t.approval])).toEqual([
      ['search', true, 'active', 'always_allow'],
      ['added', false, 'pending_review', 'default'],
    ]);
  });

  it('gives up with a 409 after repeated losses', async () => {
    state.listed = listed([{ name: 'search', description: 'Search' }]);
    for (let i = 0; i < DISCOVERY_MAX_ATTEMPTS; i++) state.beforeWrite.push(() => saveReview('nothing', {}));
    await expect(discoverConnectionTools('c1', 'user-1')).rejects.toBeInstanceOf(ConflictError);
    expect(repo.setStatus).not.toHaveBeenCalled();
  });

  it('drops badly named tools, counts the client-side drops too, and audits only hashes of the names', async () => {
    state.listed = listed(
      [
        { name: 'ok', description: 'fine' },
        { name: 'bad name <system>', description: 'x' },
      ],
      [{ name: 'huge', reason: 'schema_too_large' }]
    );
    const outcome = await discoverConnectionTools('c1', 'user-1');

    expect(outcome.dropped).toBe(2);
    expect(state.doc!.tools.map(t => t.name)).toEqual(['ok']);
    expect(repo.updateDiscovery).toHaveBeenCalledWith('c1', expect.objectContaining({ dropped: 2 }));
    const droppedAudit = state.audits.find(a => a.action === 'tools_dropped');
    expect(droppedAudit?.metadata).toMatchObject({ droppedCount: 1, reasons: ['invalid_name'] });
    expect(JSON.stringify(state.audits)).not.toContain('bad name');
  });

  it('leaves review choices alone when nothing changed', async () => {
    state.listed = listed([{ name: 'search', description: 'Search' }]);
    await discoverConnectionTools('c1', 'user-1');
    saveReview('search', { enabled: true, state: 'active' });
    const fingerprint = state.doc!.toolsFingerprint;

    const outcome = await discoverConnectionTools('c1', 'user-1');
    expect(outcome.added).toEqual([]);
    expect(outcome.changed).toEqual([]);
    expect(state.doc!.tools[0]).toMatchObject({ enabled: true, state: 'active' });
    expect(state.doc!.toolsFingerprint).toBe(fingerprint);
  });
});
