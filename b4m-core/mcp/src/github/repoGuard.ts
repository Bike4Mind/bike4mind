/**
 * GitHub MCP Server - Selected-Repositories Guard
 *
 * The single choke point that keeps every tool inside the user's repository selection. Tools are
 * registered through `withRepoScope(server, ...)`, which wraps each handler with the check its
 * policy names before the handler runs. A tool registered without a policy throws at startup, so a
 * new tool cannot ship unguarded.
 */

import type { McpServer, McpResponse, RepositoryInfo } from './types.js';
import { ALL_TOOL_NAMES, type ToolName } from './constants.js';
import { isRepositoryInScope, type RepoScope } from './repoScope.js';
import { createCustomErrorResponse } from './helpers/responses.js';

type ToolRepoPolicy =
  /** Addressed by the `owner` + `repo` args. */
  | { kind: 'owner-repo' }
  /** Addressed by a GraphQL node ID that must resolve to an allowed repository first. */
  | { kind: 'node-id'; param: string; resolveWith: keyof RepositoryResolvers }
  /** Spans repositories; the handler filters its results to the scope itself. */
  | { kind: 'results-filtered' }
  /** Reads user-, org- or project-level data, never repository content. */
  | { kind: 'no-repository' };

export type RepositoryResolvers = {
  /** Issue node ID to its repository; null when it cannot be resolved. */
  fromIssueNodeId: (nodeId: string) => Promise<RepositoryInfo | null>;
  /** Project item ID to the repository of its issue or pull request; null for a draft or on error. */
  fromProjectItemId: (itemId: string) => Promise<RepositoryInfo | null>;
};

const OWNER_REPO: ToolRepoPolicy = { kind: 'owner-repo' };
const NO_REPOSITORY: ToolRepoPolicy = { kind: 'no-repository' };
const RESULTS_FILTERED: ToolRepoPolicy = { kind: 'results-filtered' };
const ISSUE_NODE: ToolRepoPolicy = { kind: 'node-id', param: 'issue_node_id', resolveWith: 'fromIssueNodeId' };
const PROJECT_ITEM: ToolRepoPolicy = { kind: 'node-id', param: 'item_id', resolveWith: 'fromProjectItemId' };

export const TOOL_REPO_POLICIES: Readonly<Record<ToolName, ToolRepoPolicy>> = {
  current_user: NO_REPOSITORY,
  create_issue: OWNER_REPO,
  update_issue: OWNER_REPO,
  list_issues: OWNER_REPO,
  get_issue: OWNER_REPO,
  create_issue_comment: OWNER_REPO,
  create_label: OWNER_REPO,
  update_label: OWNER_REPO,
  delete_label: OWNER_REPO,
  list_labels: OWNER_REPO,
  list_org_issue_types: NO_REPOSITORY,
  search_code: RESULTS_FILTERED,
  list_repositories: RESULTS_FILTERED,
  get_repository: OWNER_REPO,
  list_branches: OWNER_REPO,
  create_branch: OWNER_REPO,
  create_or_update_file: OWNER_REPO,
  list_commits: OWNER_REPO,
  get_commit: OWNER_REPO,
  list_pull_requests: OWNER_REPO,
  get_pull_request: OWNER_REPO,
  get_pull_request_files: OWNER_REPO,
  get_pull_request_diff: OWNER_REPO,
  create_pull_request: OWNER_REPO,
  update_pull_request: OWNER_REPO,
  merge_pull_request: OWNER_REPO,
  search_pull_requests: OWNER_REPO,
  create_review: OWNER_REPO,
  approve_pr: OWNER_REPO,
  request_changes: OWNER_REPO,
  list_org_projects: NO_REPOSITORY,
  list_project_fields: NO_REPOSITORY,
  get_project_item: ISSUE_NODE,
  add_issue_to_project: ISSUE_NODE,
  update_project_item_fields: PROJECT_ITEM,
  create_milestone: OWNER_REPO,
  update_milestone: OWNER_REPO,
  list_milestones: OWNER_REPO,
  close_milestone: OWNER_REPO,
  list_workflow_runs: OWNER_REPO,
  get_workflow_run_details: OWNER_REPO,
  get_workflow_run_logs: OWNER_REPO,
  get_job_logs: OWNER_REPO,
};

type ToolHandler = (args: Record<string, unknown>, ...rest: unknown[]) => Promise<McpResponse>;

const isToolName = (name: string): name is ToolName => (ALL_TOOL_NAMES as readonly string[]).includes(name);

function outsideSelectionResponse(fullName: string): McpResponse {
  return createCustomErrorResponse(
    `Repository "${fullName}" is not in the repositories selected for this GitHub connection. ` +
      'Add it in Settings > Connected Apps > GitHub to use it.',
    { repository: fullName }
  );
}

/** Returns a refusal, or null when the call may proceed. */
async function checkRepositoryAccess(
  policy: ToolRepoPolicy,
  args: Record<string, unknown>,
  scope: RepoScope,
  resolvers: RepositoryResolvers
): Promise<McpResponse | null> {
  switch (policy.kind) {
    case 'no-repository':
    case 'results-filtered':
      return null;
    case 'owner-repo': {
      const { owner, repo } = args;
      if (typeof owner !== 'string' || typeof repo !== 'string') {
        return createCustomErrorResponse('Both owner and repo are required to check repository access.');
      }
      const fullName = `${owner}/${repo}`;
      return isRepositoryInScope(scope, fullName) ? null : outsideSelectionResponse(fullName);
    }
    case 'node-id': {
      const nodeId = args[policy.param];
      const repository = typeof nodeId === 'string' ? await resolvers[policy.resolveWith](nodeId) : null;
      if (!repository) {
        return createCustomErrorResponse(
          `Could not determine which repository ${policy.param} "${String(nodeId)}" belongs to, ` +
            'so it cannot be checked against the repositories selected for this GitHub connection.',
          { [policy.param]: nodeId }
        );
      }
      return isRepositoryInScope(scope, repository.fullName) ? null : outsideSelectionResponse(repository.fullName);
    }
  }
}

function guardHandler(
  policy: ToolRepoPolicy,
  handler: ToolHandler,
  scope: RepoScope,
  resolvers: RepositoryResolvers
): ToolHandler {
  return async (args, ...rest) => {
    const refusal = await checkRepositoryAccess(policy, args, scope, resolvers);
    return refusal ?? handler(args, ...rest);
  };
}

/**
 * Wrap `server` so every `tool(...)` registration is guarded by the repository scope. With all
 * repositories selected the server is returned untouched: no checks and no extra API calls.
 */
export function withRepoScope(server: McpServer, scope: RepoScope, resolvers: RepositoryResolvers): McpServer {
  if (scope.mode === 'all') return server;

  const registerTool = server.tool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  const guardedTool = (name: string, ...rest: unknown[]): unknown => {
    if (!isToolName(name)) {
      throw new Error(`GitHub tool "${name}" has no repository policy in TOOL_REPO_POLICIES`);
    }
    const handler = rest.pop() as ToolHandler;
    return registerTool(name, ...rest, guardHandler(TOOL_REPO_POLICIES[name], handler, scope, resolvers));
  };

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'tool') return guardedTool;
      // registerTool would bypass the guard; every GitHub tool goes through tool().
      if (property === 'registerTool') {
        return () => {
          throw new Error('Register GitHub tools with tool() so the repository guard applies');
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
