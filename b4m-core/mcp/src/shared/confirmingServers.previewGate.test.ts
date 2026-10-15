/**
 * The subagent permission gate trusts every tool of the `github` and `atlassian` MCP servers
 * (isConfirmingMcpTool in b4m-core/services). That holds only while no tool writes without the
 * host-set `_executeFromButton`, so this drives every registered tool without it and fails on any
 * non-GET request or GraphQL mutation. A new tool must be classified below.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { z } from 'zod';

vi.hoisted(() => {
  process.env.GITHUB_ACCESS_TOKEN = 'test-token';
  process.env.GITHUB_SELECTED_REPOSITORIES = JSON.stringify(['octocat/test']);
  process.env.ATLASSIAN_ACCESS_TOKEN = 'test-token';
  process.env.ATLASSIAN_CLOUD_ID = 'test-cloud';
  process.env.ATLASSIAN_SITE_URL = 'https://example.atlassian.net';
});

import { registerGitHubTools } from '../github/registerTools.js';
import { ALL_TOOL_NAMES as GITHUB_TOOL_NAMES } from '../github/constants.js';
import { ALL_ATLASSIAN_TOOL_NAMES } from '../atlassian/constants.js';
import { registerJiraIssueTools } from '../atlassian/tools/jira-issues.js';
import { registerJiraProjectTools } from '../atlassian/tools/jira-projects.js';
import { registerJiraWorkflowTools } from '../atlassian/tools/jira-workflows.js';
import { registerJiraUserTools } from '../atlassian/tools/jira-users.js';
import { registerJiraLinkTools } from '../atlassian/tools/jira-links.js';
import { registerJiraAttachmentTools } from '../atlassian/tools/jira-attachments.js';
import { registerJiraAgileTools } from '../atlassian/tools/jira-agile.js';
import { registerConfluencePageTools } from '../atlassian/tools/confluence-pages.js';
import { registerConfluenceCommentTools } from '../atlassian/tools/confluence-comments.js';
import { registerConfluenceRestrictionTools } from '../atlassian/tools/confluence-restrictions.js';
import { registerConfluenceAttachmentTools } from '../atlassian/tools/confluence-attachments.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type CapturedTool = { handler: ToolHandler; shape: Record<string, z.ZodType> };

const GITHUB_WRITE_TOOLS = [
  'create_issue',
  'update_issue',
  'create_issue_comment',
  'create_label',
  'update_label',
  'delete_label',
  'create_branch',
  'create_or_update_file',
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'create_review',
  'approve_pr',
  'request_changes',
  'add_issue_to_project',
  'update_project_item_fields',
  'create_milestone',
  'update_milestone',
  'close_milestone',
];

const GITHUB_READ_TOOLS = [
  'current_user',
  'list_issues',
  'get_issue',
  'list_labels',
  'list_org_issue_types',
  'search_code',
  'list_repositories',
  'get_repository',
  'list_branches',
  'list_commits',
  'get_commit',
  'list_pull_requests',
  'get_pull_request',
  'get_pull_request_files',
  'get_pull_request_diff',
  'search_pull_requests',
  'list_org_projects',
  'list_project_fields',
  'get_project_item',
  'list_milestones',
  'list_workflow_runs',
  'get_workflow_run_details',
  'get_workflow_run_logs',
  'get_job_logs',
];

const ATLASSIAN_WRITE_TOOLS = [
  'jira_create_issue',
  'jira_bulk_create_issues',
  'jira_bulk_transition_issues',
  'jira_bulk_update_issues',
  'jira_update_issue',
  'jira_add_comment',
  'jira_update_issue_transition',
  'jira_assign_issue',
  'jira_delete_issue',
  'jira_add_watcher',
  'jira_remove_watcher',
  'jira_create_issue_link',
  'jira_create_issue_links',
  'jira_delete_issue_link',
  'jira_upload_attachment',
  'jira_delete_attachment',
  'jira_create_sprint',
  'jira_update_sprint',
  'jira_move_issues_to_sprint',
  'confluence_create_page',
  'confluence_update_page',
  'confluence_delete_page',
  'confluence_add_page_restriction',
  'confluence_remove_page_restriction',
  'confluence_create_comment',
  'confluence_reply_to_comment',
  'confluence_update_comment',
  'confluence_delete_comment',
  'confluence_upload_attachment',
  'confluence_delete_attachment',
];

const ATLASSIAN_READ_TOOLS = [
  'jira_get_issue',
  'jira_search_issues',
  'jira_list_projects',
  'jira_get_project',
  'jira_list_issue_types',
  'jira_list_project_members',
  'jira_get_transitions',
  'jira_get_current_user',
  'jira_search_users',
  'jira_list_watchers',
  'jira_list_link_types',
  'jira_list_issue_links',
  'jira_list_attachments',
  'jira_download_attachment',
  'jira_list_boards',
  'jira_get_board',
  'jira_list_sprints',
  'jira_get_sprint',
  'jira_get_sprint_issues',
  'jira_get_board_configuration',
  'jira_get_board_issues',
  'confluence_get_page',
  'confluence_search',
  'confluence_list_spaces',
  'confluence_get_space',
  'confluence_get_page_children',
  'confluence_get_current_user',
  'confluence_list_pages',
  'confluence_get_page_restrictions',
  'confluence_list_comments',
  'confluence_get_comment',
  'confluence_list_attachments',
  'confluence_download_attachment',
];

/** Tools the harness cannot drive; each needs a reason. Currently every tool is driven. */
const KNOWN_UNDRIVEN: ReadonlyArray<{ server: 'github' | 'atlassian'; tool: string; reason: string }> = [];

// Args the schema-driven generator cannot infer (nested required fields, semantic values).
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  jira_bulk_create_issues: { issues: [{ projectKey: 'PROJ', summary: 's', issueTypeName: 'Task' }] },
  jira_bulk_transition_issues: { issues: [{ issueIdOrKey: 'PROJ-1', transitionId: '11' }] },
  jira_bulk_update_issues: { labels: { values: ['x'], action: 'ADD' } },
  jira_create_issue_links: { links: [{ linkType: 'Blocks', sourceIssue: 'PROJ-1', targetIssue: 'PROJ-2' }] },
  confluence_add_page_restriction: { operation: 'read', restrictionType: 'user', subject: 'acct-2' },
  confluence_remove_page_restriction: { operation: 'read', restrictionType: 'user', subject: 'acct-1' },
  update_pull_request: { title: 'new title' },
  create_label: { color: 'ff0000' },
  list_project_fields: { project_id: 'PVT_1' },
  get_project_item: { project_id: 'PVT_1', issue_node_id: 'I_1' },
  add_issue_to_project: { project_id: 'PVT_1', issue_node_id: 'I_1' },
  update_project_item_fields: {
    project_id: 'PVT_1',
    item_id: 'PVTI_1',
    updates: [{ field_id: 'PVTF_1', value: 'x', field_name: 'Status', new_value: 'Done' }],
  },
};

const CANDIDATES: unknown[] = ['test', '1', 'PROJ-1', 1, true, ['test'], [1], [{}], {}, 'open'];

function valueFor(key: string, schema: z.ZodType): unknown {
  if (key === 'owner') return 'octocat';
  if (key === 'repo') return 'test';
  if (key === 'pageId') return '123';
  const options = (schema as unknown as { options?: unknown[] }).options;
  const candidates = Array.isArray(options) ? [...options, ...CANDIDATES] : CANDIDATES;
  return candidates.find(candidate => schema.safeParse(candidate).success);
}

function minimalArgs(tool: string, shape: Record<string, z.ZodType>): Record<string, unknown> {
  const generated: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (key === 'owner' || key === 'repo' || key === 'pageId' || !schema.safeParse(undefined).success) {
      const value = valueFor(key, schema);
      if (value !== undefined) generated[key] = value;
    }
  }
  // `confirmed: true` is the model-controllable flag; the gate must not honour it.
  return { ...generated, ...ARG_OVERRIDES[tool], confirmed: true };
}

function captureTools(register: (server: McpServer) => void): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      const handler = rest[rest.length - 1] as ToolHandler;
      const shape = rest.find(
        (arg): arg is Record<string, z.ZodType> => typeof arg === 'object' && arg !== null && !Array.isArray(arg)
      );
      tools.set(name, { handler, shape: shape ?? {} });
    },
  } as unknown as McpServer;
  register(server);
  return tools;
}

type RecordedRequest = { method: string; url: string; body: string };
const requests: RecordedRequest[] = [];

const isWrite = ({ method, url, body }: RecordedRequest): boolean =>
  url.endsWith('/graphql') ? /\bmutation\b/i.test(body) : method !== 'GET' && method !== 'HEAD';

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const request = input instanceof Request ? input : null;
      requests.push({
        method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
        url: String(request?.url ?? input),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const url = String(request?.url ?? input);
      // create_branch previews only when the branch does not exist yet.
      if (/\/branches\/[^/]+$/.test(url)) return new Response('{"message":"Not Found"}', { status: 404 });
      // confluence_remove_page_restriction previews only when the restriction exists.
      const body = url.includes('/restriction')
        ? { results: [{ operation: 'read', restrictions: { user: { results: [{ accountId: 'acct-1' }] } } }] }
        : CANNED_BODY;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

// One body shaped loosely like a PR, a ref and a GraphQL envelope, so reads proceed to the write path.
const PROJECT_FIXTURE = { __typename: 'ProjectV2', id: 'PVT_1', title: 'Board' };
const ISSUE_FIXTURE = { __typename: 'Issue', number: 1, title: 't', repository: { nameWithOwner: 'octocat/test' } };

// The write previews resolve the project, item and content before they answer, so the GraphQL envelope carries all three.
const CANNED_BODY = {
  data: {
    project: PROJECT_FIXTURE,
    content: ISSUE_FIXTURE,
    node: {
      __typename: 'ProjectV2Item',
      project: PROJECT_FIXTURE,
      content: ISSUE_FIXTURE,
      fields: { nodes: [{ id: 'PVTF_1', name: 'Status', dataType: 'TEXT' }] },
    },
  },
  // The Jira delete preview names the file from the attachment lookup.
  filename: 'file.txt',
  number: 1,
  title: 't',
  state: 'open',
  merged: false,
  mergeable: true,
  draft: false,
  user: { login: 'octocat' },
  head: { ref: 'feature', sha: 'abc123', repo: { full_name: 'octocat/test' } },
  base: { ref: 'main', sha: 'def456', repo: { full_name: 'octocat/test' } },
  object: { sha: 'abc123' },
};

const resolvers = {
  fromIssueNodeId: async () => ({ owner: 'octocat', repo: 'test', fullName: 'octocat/test' }),
  fromProjectItemId: async () => ({ owner: 'octocat', repo: 'test', fullName: 'octocat/test' }),
};

const parsePreview = (result: ToolResult): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(result.content[0]?.text ?? '');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const atlassianRegistrations = [
  registerJiraIssueTools,
  registerJiraProjectTools,
  registerJiraWorkflowTools,
  registerJiraUserTools,
  registerJiraLinkTools,
  registerJiraAttachmentTools,
  registerJiraAgileTools,
  registerConfluencePageTools,
  registerConfluenceCommentTools,
  registerConfluenceRestrictionTools,
  registerConfluenceAttachmentTools,
];

type ServerUnderTest = {
  label: string;
  tools: Map<string, CapturedTool>;
  declared: readonly string[];
  writes: string[];
  reads: string[];
};

const servers: ServerUnderTest[] = [];

beforeAll(() => {
  stubFetch();
  servers.push(
    {
      label: 'github',
      tools: captureTools(server => registerGitHubTools(server, resolvers)),
      declared: GITHUB_TOOL_NAMES,
      writes: GITHUB_WRITE_TOOLS,
      reads: GITHUB_READ_TOOLS,
    },
    {
      label: 'atlassian',
      tools: captureTools(server => atlassianRegistrations.forEach(register => register(server))),
      declared: ALL_ATLASSIAN_TOOL_NAMES,
      writes: ATLASSIAN_WRITE_TOOLS,
      reads: ATLASSIAN_READ_TOOLS,
    }
  );
});

beforeEach(() => {
  requests.length = 0;
});

describe.each(['github', 'atlassian'])('%s MCP server preview gate', label => {
  const serverUnderTest = (): ServerUnderTest => servers.find(candidate => candidate.label === label)!;

  it('classifies exactly the registered tools as read or write', () => {
    const { tools, declared, writes, reads } = serverUnderTest();
    const registered = [...tools.keys()].sort();
    expect(registered).toEqual([...declared].sort());
    expect([...writes, ...reads].sort()).toEqual(registered);
    expect(new Set([...writes, ...reads]).size).toBe(writes.length + reads.length);
  });

  it('drives every tool (no silent skips)', () => {
    const { tools } = serverUnderTest();
    const undriven = KNOWN_UNDRIVEN.filter(entry => entry.server === label).map(entry => entry.tool);
    const invalid: string[] = [];
    for (const [name, { shape }] of tools) {
      if (undriven.includes(name)) continue;
      const { confirmed: _confirmed, ...withoutFlag } = minimalArgs(name, shape);
      for (const [key, schema] of Object.entries(shape)) {
        if (!schema.safeParse(withoutFlag[key]).success) invalid.push(`${name}.${key}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it('never issues a write request from any tool without _executeFromButton', async () => {
    const { tools } = serverUnderTest();
    const undriven = KNOWN_UNDRIVEN.filter(entry => entry.server === label).map(entry => entry.tool);
    for (const [name, { handler, shape }] of tools) {
      if (undriven.includes(name)) continue;
      requests.length = 0;
      await handler(minimalArgs(name, shape)).catch(() => undefined);
      expect({ name, writes: requests.filter(isWrite) }).toEqual({ name, writes: [] });
    }
  });

  it('answers every write tool with a confirmation preview', async () => {
    const { tools, writes } = serverUnderTest();
    const notPreviews: string[] = [];
    for (const name of writes) {
      const tool = tools.get(name)!;
      const result = await tool.handler(minimalArgs(name, tool.shape)).catch((error: unknown) => ({
        content: [{ type: 'text', text: String(error) }],
      }));
      const preview = parsePreview(result);
      const isPreview =
        preview?.action === 'preview' &&
        preview.confirmation_required === true &&
        typeof preview._confirmToken === 'string';
      if (!isPreview) notPreviews.push(`${name}: ${result.content[0]?.text.slice(0, 160)}`);
    }
    expect(notPreviews).toEqual([]);
  });
});
