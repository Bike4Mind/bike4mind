import { describe, it, expect, vi } from 'vitest';
import { loadAgentMcpTools } from './loadAgentMcpTools';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;
const getMcpClient = vi.fn(async () => ({
  getTools: vi.fn(async () => []),
  callTool: vi.fn(async () => ({ content: [{ text: 'ok' }] })),
}));

const atlassian = {
  id: 'a1',
  name: 'atlassian',
  userId: 'u1',
  enabled: true,
  toolSchemas: [{ name: 'jira_list_projects', description: 'list', input_schema: {} }],
} as any;

describe('loadAgentMcpTools', () => {
  it('returns empty when MCP is disabled and does not hit the DB', async () => {
    const mcpServers = { find: vi.fn() };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient, logger },
      { userId: 'u1', enableMCPServer: false }
    );
    expect(mcpToolsByServer).toEqual({});
    expect(mcpServers.find).not.toHaveBeenCalled();
  });

  it('groups namespaced tools by server for enabled servers with schemas', async () => {
    const mcpServers = { find: vi.fn(async () => [atlassian]) };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(mcpServers.find).toHaveBeenCalledWith({ enabled: true, userId: 'u1' });
    expect(Object.keys(mcpToolsByServer)).toEqual(['atlassian']);
    expect(mcpToolsByServer.atlassian).toHaveLength(1);
    expect(mcpToolsByServer.atlassian[0].name).toBe('atlassian__jira_list_projects');
  });

  it('live-fetches a never-fetched empty server and records the confirmed-empty marker', async () => {
    const bare = { id: 'b1', name: 'github', userId: 'u1', enabled: true, toolSchemas: [] } as any;
    const emptyGetTools = vi.fn(async () => []);
    const emptyClient = vi.fn(async () => ({ getTools: emptyGetTools, callTool: vi.fn() }));
    const mcpServers = { find: vi.fn(async () => [bare]), update: vi.fn() };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient: emptyClient, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(mcpToolsByServer).toEqual({});
    expect(emptyGetTools).toHaveBeenCalledTimes(1);
    // Empty is persisted as confirmed-empty, with the marker that makes it meaningful.
    expect(mcpServers.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1', tools: [], toolSchemas: [], toolSchemasFetchedAt: expect.any(Date) })
    );
  });

  it('skips the live fetch for a confirmed-empty server whose marker is still fresh', async () => {
    const bare = {
      id: 'b1',
      name: 'github',
      userId: 'u1',
      enabled: true,
      toolSchemas: [],
      toolSchemasFetchedAt: new Date(),
    } as any;
    const client = vi.fn(async () => ({ getTools: vi.fn(), callTool: vi.fn() }));
    const mcpServers = { find: vi.fn(async () => [bare]), update: vi.fn() };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient: client, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(mcpToolsByServer).toEqual({});
    expect(client).not.toHaveBeenCalled();
    expect(mcpServers.update).not.toHaveBeenCalled();
  });

  it('refetches a confirmed-empty server once its marker ages past the TTL', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const bare = {
      id: 'b1',
      name: 'github',
      userId: 'u1',
      enabled: true,
      toolSchemas: [],
      toolSchemasFetchedAt: stale,
    } as any;
    const emptyGetTools = vi.fn(async () => []);
    const client = vi.fn(async () => ({ getTools: emptyGetTools, callTool: vi.fn() }));
    const mcpServers = { find: vi.fn(async () => [bare]), update: vi.fn() };
    await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient: client, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(emptyGetTools).toHaveBeenCalledTimes(1);
  });

  it('does not persist on a failed live fetch, so the next turn retries', async () => {
    const bare = { id: 'b1', name: 'github', userId: 'u1', enabled: true, toolSchemas: [] } as any;
    const failingGetTools = vi.fn(async () => {
      throw new Error('lambda cold start');
    });
    const client = vi.fn(async () => ({ getTools: failingGetTools, callTool: vi.fn() }));
    const mcpServers = { find: vi.fn(async () => [bare]), update: vi.fn() };
    const deps = { mcpServers: mcpServers as any, getMcpClient: client, logger };

    await loadAgentMcpTools(deps, { userId: 'u1', enableMCPServer: true });
    await loadAgentMcpTools(deps, { userId: 'u1', enableMCPServer: true });

    expect(mcpServers.update).not.toHaveBeenCalled();
    // No marker was written, so the second turn still attempts a live fetch.
    expect(failingGetTools).toHaveBeenCalledTimes(2);
  });

  it('live-fetches and caches non-empty tool schemas with the marker', async () => {
    const bare = { id: 'b1', name: 'notion', userId: 'u1', enabled: true, toolSchemas: [] } as any;
    const liveTools = [
      { name: 'notion_search', description: 'search', input_schema: {} },
      { name: 'notion_create_page', description: 'create', input_schema: {} },
    ];
    const liveGetTools = vi.fn(async () => liveTools);
    const liveClient = vi.fn(async () => ({ getTools: liveGetTools, callTool: vi.fn() }));
    const update = vi.fn();
    const mcpServers = { find: vi.fn(async () => [bare]), update };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient: liveClient, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(Object.keys(mcpToolsByServer)).toEqual(['notion']);
    expect(mcpToolsByServer.notion).toHaveLength(2);
    // Should have persisted the schemas
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'b1',
        tools: ['notion_search', 'notion_create_page'],
        toolSchemas: liveTools,
        toolSchemasFetchedAt: expect.any(Date),
      })
    );
  });

  it('isolates a failing server so the others still load', async () => {
    // A malformed schema entry (null) makes generateMcpToolsFromCache throw for that
    // server; the per-server try/catch must skip it and still load the healthy one.
    const bad = { id: 'x1', name: 'bad', userId: 'u1', enabled: true, toolSchemas: [null] } as any;
    const mcpServers = { find: vi.fn(async () => [bad, atlassian]) };
    const warn = vi.fn();
    const isoLogger = { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } as any;

    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient, logger: isoLogger },
      { userId: 'u1', enableMCPServer: true }
    );

    // 'bad' dropped, 'atlassian' (ordered after it) still loaded - the loop did not abort.
    expect(Object.keys(mcpToolsByServer)).toEqual(['atlassian']);
    expect(mcpToolsByServer.atlassian).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to build tools for bad'),
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('derives serverAgentConfig from github metadata', async () => {
    const github = {
      id: 'g1',
      name: 'github',
      userId: 'u1',
      enabled: true,
      toolSchemas: [{ name: 'list_repos' }],
      metadata: { githubLogin: 'octocat', selectedRepositories: [{ fullName: 'octocat/hello' }] },
    } as any;
    const mcpServers = { find: vi.fn(async () => [github]) };
    const { serverAgentConfig } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(serverAgentConfig.githubUsername).toBe('octocat');
    expect(serverAgentConfig.selectedRepositories).toContain('octocat/hello');
  });
});
