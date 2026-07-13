import { describe, it, expect, vi } from 'vitest';
import { loadAgentMcpTools } from './loadAgentMcpTools';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any;
const getMcpClient = vi.fn(async () => ({ callTool: vi.fn(async () => ({ content: [{ text: 'ok' }] })) }));

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

  it('skips enabled servers with no cached schemas', async () => {
    const bare = { id: 'b1', name: 'github', userId: 'u1', enabled: true, toolSchemas: [] } as any;
    const mcpServers = { find: vi.fn(async () => [bare]) };
    const { mcpToolsByServer } = await loadAgentMcpTools(
      { mcpServers: mcpServers as any, getMcpClient, logger },
      { userId: 'u1', enableMCPServer: true }
    );
    expect(mcpToolsByServer).toEqual({});
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
