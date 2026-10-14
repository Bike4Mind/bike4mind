import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({ githubToken: 'mock-token' }));

vi.mock('../client.js', () => ({
  octokit: {
    issues: { create: vi.fn() },
    graphql: vi.fn(),
  },
}));

import type { McpServer } from '../types.js';
import { octokit } from '../client.js';
import { ALL_TOOL_NAMES, type ToolName } from '../constants.js';
import { TOOL_REPO_POLICIES, withRepoScope, type RepositoryResolvers } from '../repoGuard.js';
import { ALL_REPOSITORIES, parseRepoScope } from '../repoScope.js';
import { registerGitHubTools } from '../registerTools.js';
import { createMockServer, parseResponse, type McpToolResponse, type RegisteredTool } from './test-utils.js';

const SELECTED = parseRepoScope(JSON.stringify(['Acme/Allowed-Repo']));
const ALLOWED = { owner: 'acme', repo: 'allowed-repo', fullName: 'acme/allowed-repo' };
const BLOCKED = { owner: 'other-org', repo: 'secret', fullName: 'other-org/secret' };

type GuardedHandler = (args: Record<string, unknown>) => Promise<McpToolResponse>;

function registerThroughGuard(
  toolName: string,
  resolvers: RepositoryResolvers,
  scope = SELECTED
): { handler: GuardedHandler; inner: ReturnType<typeof vi.fn> } {
  const { server, registeredTools } = createMockServer();
  const inner = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"success":true}' }] }));
  withRepoScope(server, scope, resolvers).tool(toolName, {}, inner);
  return { handler: registeredTools.get(toolName)!.handler, inner };
}

function resolversReturning(repository: typeof ALLOWED | null): RepositoryResolvers {
  return {
    fromIssueNodeId: vi.fn(async () => repository),
    fromProjectItemId: vi.fn(async () => repository),
  };
}

const toolsWithPolicy = (kind: string): ToolName[] =>
  (Object.keys(TOOL_REPO_POLICIES) as ToolName[]).filter(name => TOOL_REPO_POLICIES[name].kind === kind);

describe('withRepoScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('owner + repo addressed tools', () => {
    it.each(toolsWithPolicy('owner-repo'))('%s runs for a selected repository, case-insensitively', async name => {
      const { handler, inner } = registerThroughGuard(name, resolversReturning(null));

      await handler({ owner: 'ACME', repo: 'Allowed-REPO' });

      expect(inner).toHaveBeenCalledOnce();
    });

    it.each(toolsWithPolicy('owner-repo'))('%s refuses a repository outside the selection', async name => {
      const { handler, inner } = registerThroughGuard(name, resolversReturning(null));

      const result = await handler({ owner: BLOCKED.owner, repo: BLOCKED.repo });

      expect(inner).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(parseResponse(result).error).toContain(
        `Repository "${BLOCKED.fullName}" is not in the repositories selected`
      );
    });
  });

  describe('node-ID addressed tools', () => {
    it.each(toolsWithPolicy('node-id'))('%s runs when the node resolves to a selected repository', async name => {
      const { handler, inner } = registerThroughGuard(name, resolversReturning(ALLOWED));

      await handler({ issue_node_id: 'I_allowed', item_id: 'PVTI_allowed', project_id: 'PVT_1' });

      expect(inner).toHaveBeenCalledOnce();
    });

    it.each(toolsWithPolicy('node-id'))('%s refuses a node in a repository outside the selection', async name => {
      const { handler, inner } = registerThroughGuard(name, resolversReturning(BLOCKED));

      const result = await handler({ issue_node_id: 'I_blocked', item_id: 'PVTI_blocked', project_id: 'PVT_1' });

      expect(inner).not.toHaveBeenCalled();
      expect(parseResponse(result).error).toContain(`Repository "${BLOCKED.fullName}"`);
    });

    it.each(toolsWithPolicy('node-id'))('%s fails closed when the node cannot be resolved', async name => {
      const { handler, inner } = registerThroughGuard(name, resolversReturning(null));

      const result = await handler({ issue_node_id: 'I_draft', item_id: 'PVTI_draft', project_id: 'PVT_1' });

      expect(inner).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(parseResponse(result).error).toContain('Could not determine which repository');
    });

    it('resolves add_issue_to_project by its issue node and update_project_item_fields by its item', async () => {
      const resolvers = resolversReturning(ALLOWED);

      await registerThroughGuard('add_issue_to_project', resolvers).handler({ issue_node_id: 'I_1' });
      await registerThroughGuard('update_project_item_fields', resolvers).handler({ item_id: 'PVTI_1' });

      expect(resolvers.fromIssueNodeId).toHaveBeenCalledWith('I_1');
      expect(resolvers.fromProjectItemId).toHaveBeenCalledWith('PVTI_1');
    });
  });

  describe('tools that do not address a single repository', () => {
    it.each([...toolsWithPolicy('no-repository'), ...toolsWithPolicy('results-filtered')])(
      '%s runs without a repository check',
      async name => {
        const resolvers = resolversReturning(null);
        const { handler, inner } = registerThroughGuard(name, resolvers);

        await handler({ org: 'acme', project_id: 'PVT_1', query: 'x' });

        expect(inner).toHaveBeenCalledOnce();
        expect(resolvers.fromIssueNodeId).not.toHaveBeenCalled();
      }
    );
  });

  describe('all repositories selected', () => {
    it('returns the server untouched, so no tool is checked', () => {
      const { server } = createMockServer();

      expect(withRepoScope(server, ALL_REPOSITORIES, resolversReturning(null))).toBe(server);
    });

    it('lets a node-ID write through without resolving the node', async () => {
      const resolvers = resolversReturning(BLOCKED);
      const { handler, inner } = registerThroughGuard('add_issue_to_project', resolvers, ALL_REPOSITORIES);

      await handler({ issue_node_id: 'I_anywhere' });

      expect(inner).toHaveBeenCalledOnce();
      expect(resolvers.fromIssueNodeId).not.toHaveBeenCalled();
    });
  });

  it('refuses to register a tool that has no repository policy', () => {
    const { server } = createMockServer();
    const guarded = withRepoScope(server, SELECTED, resolversReturning(null));

    expect(() => guarded.tool('brand_new_tool', {}, vi.fn())).toThrow(/no repository policy/);
  });

  it('blocks registerTool, which would bypass the guard', () => {
    const guarded = withRepoScope({ tool: vi.fn(), registerTool: vi.fn() } as unknown as McpServer, SELECTED, {
      ...resolversReturning(null),
    });

    expect(() => guarded.registerTool('list_issues', {}, vi.fn())).toThrow(/repository guard/);
  });
});

describe('the real tool registrations', () => {
  function registerAllTools(): Map<string, RegisteredTool> {
    const { server, registeredTools } = createMockServer();
    registerGitHubTools(server, SELECTED, resolversReturning(BLOCKED));
    return registeredTools;
  }

  it('registers every declared tool, each with a repository policy', () => {
    const registered = registerAllTools();

    expect([...registered.keys()].sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('refuses a confirmed create_issue in an unselected repository before calling GitHub', async () => {
    const result = await registerAllTools()
      .get('create_issue')!
      .handler({ owner: BLOCKED.owner, repo: BLOCKED.repo, title: 't', _executeFromButton: true });

    expect(result.isError).toBe(true);
    expect(octokit.issues.create).not.toHaveBeenCalled();
  });

  it('refuses add_issue_to_project for an issue in an unselected repository before mutating', async () => {
    const result = await registerAllTools()
      .get('add_issue_to_project')!
      .handler({ project_id: 'PVT_1', issue_node_id: 'I_blocked', _executeFromButton: true });

    expect(result.isError).toBe(true);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});
