/**
 * GitHub MCP Server - Constants
 *
 * Tool names and other constants used across the GitHub MCP server.
 */

// User Tools
export const TOOL_CURRENT_USER = 'current_user' as const;

// Issue Tools
export const TOOL_CREATE_ISSUE = 'create_issue' as const;
export const TOOL_UPDATE_ISSUE = 'update_issue' as const;
export const TOOL_LIST_ISSUES = 'list_issues' as const;
export const TOOL_GET_ISSUE = 'get_issue' as const;
export const TOOL_CREATE_ISSUE_COMMENT = 'create_issue_comment' as const;

// Label Tools
export const TOOL_CREATE_LABEL = 'create_label' as const;
export const TOOL_UPDATE_LABEL = 'update_label' as const;
export const TOOL_DELETE_LABEL = 'delete_label' as const;
export const TOOL_LIST_LABELS = 'list_labels' as const;

// Issue Type Tools
export const TOOL_LIST_ORG_ISSUE_TYPES = 'list_org_issue_types' as const;

// Repository Tools
export const TOOL_LIST_REPOSITORIES = 'list_repositories' as const;
export const TOOL_GET_REPOSITORY = 'get_repository' as const;

// Branch Tools
export const TOOL_LIST_BRANCHES = 'list_branches' as const;
export const TOOL_CREATE_BRANCH = 'create_branch' as const;

// File Contents Tools
export const TOOL_CREATE_OR_UPDATE_FILE = 'create_or_update_file' as const;

// Commit Tools
export const TOOL_LIST_COMMITS = 'list_commits' as const;
export const TOOL_GET_COMMIT = 'get_commit' as const;

// Pull Request Tools
export const TOOL_LIST_PULL_REQUESTS = 'list_pull_requests' as const;
export const TOOL_GET_PULL_REQUEST = 'get_pull_request' as const;
export const TOOL_GET_PULL_REQUEST_FILES = 'get_pull_request_files' as const;
export const TOOL_GET_PULL_REQUEST_DIFF = 'get_pull_request_diff' as const;
export const TOOL_CREATE_PULL_REQUEST = 'create_pull_request' as const;
export const TOOL_UPDATE_PULL_REQUEST = 'update_pull_request' as const;
export const TOOL_MERGE_PULL_REQUEST = 'merge_pull_request' as const;
export const TOOL_SEARCH_PULL_REQUESTS = 'search_pull_requests' as const;

// PR Review Tools
export const TOOL_CREATE_REVIEW = 'create_review' as const;
export const TOOL_APPROVE_PR = 'approve_pr' as const;
export const TOOL_REQUEST_CHANGES = 'request_changes' as const;

// Search Tools
export const TOOL_SEARCH_CODE = 'search_code' as const;

// Project Tools
export const TOOL_LIST_ORG_PROJECTS = 'list_org_projects' as const;
export const TOOL_LIST_PROJECT_FIELDS = 'list_project_fields' as const;
export const TOOL_GET_PROJECT_ITEM = 'get_project_item' as const;
export const TOOL_ADD_ISSUE_TO_PROJECT = 'add_issue_to_project' as const;
export const TOOL_UPDATE_PROJECT_ITEM_FIELDS = 'update_project_item_fields' as const;

// Milestone Tools
export const TOOL_CREATE_MILESTONE = 'create_milestone' as const;
export const TOOL_UPDATE_MILESTONE = 'update_milestone' as const;
export const TOOL_LIST_MILESTONES = 'list_milestones' as const;
export const TOOL_CLOSE_MILESTONE = 'close_milestone' as const;

// Workflow Tools (GitHub Actions)
export const TOOL_LIST_WORKFLOW_RUNS = 'list_workflow_runs' as const;
export const TOOL_GET_WORKFLOW_RUN_DETAILS = 'get_workflow_run_details' as const;
export const TOOL_GET_WORKFLOW_RUN_LOGS = 'get_workflow_run_logs' as const;
export const TOOL_GET_JOB_LOGS = 'get_job_logs' as const;

// Tool categories for organized logging and documentation
export const TOOL_CATEGORIES = {
  User: [TOOL_CURRENT_USER],
  Issues: [TOOL_CREATE_ISSUE, TOOL_UPDATE_ISSUE, TOOL_LIST_ISSUES, TOOL_GET_ISSUE, TOOL_CREATE_ISSUE_COMMENT],
  Labels: [TOOL_CREATE_LABEL, TOOL_UPDATE_LABEL, TOOL_DELETE_LABEL, TOOL_LIST_LABELS],
  'Issue Types': [TOOL_LIST_ORG_ISSUE_TYPES],
  Search: [TOOL_SEARCH_CODE],
  Repositories: [TOOL_LIST_REPOSITORIES, TOOL_GET_REPOSITORY],
  Branches: [TOOL_LIST_BRANCHES, TOOL_CREATE_BRANCH],
  Files: [TOOL_CREATE_OR_UPDATE_FILE],
  Commits: [TOOL_LIST_COMMITS, TOOL_GET_COMMIT],
  'Pull Requests': [
    TOOL_LIST_PULL_REQUESTS,
    TOOL_GET_PULL_REQUEST,
    TOOL_GET_PULL_REQUEST_FILES,
    TOOL_GET_PULL_REQUEST_DIFF,
    TOOL_CREATE_PULL_REQUEST,
    TOOL_UPDATE_PULL_REQUEST,
    TOOL_MERGE_PULL_REQUEST,
    TOOL_SEARCH_PULL_REQUESTS,
    TOOL_CREATE_REVIEW,
    TOOL_APPROVE_PR,
    TOOL_REQUEST_CHANGES,
  ],
  'Projects v2': [
    TOOL_LIST_ORG_PROJECTS,
    TOOL_LIST_PROJECT_FIELDS,
    TOOL_GET_PROJECT_ITEM,
    TOOL_ADD_ISSUE_TO_PROJECT,
    TOOL_UPDATE_PROJECT_ITEM_FIELDS,
  ],
  Milestones: [TOOL_CREATE_MILESTONE, TOOL_UPDATE_MILESTONE, TOOL_LIST_MILESTONES, TOOL_CLOSE_MILESTONE],
  Workflows: [TOOL_LIST_WORKFLOW_RUNS, TOOL_GET_WORKFLOW_RUN_DETAILS, TOOL_GET_WORKFLOW_RUN_LOGS, TOOL_GET_JOB_LOGS],
} as const;

// All tool names for validation (derived from categories)
export const ALL_TOOL_NAMES = Object.values(TOOL_CATEGORIES).flat();

export type ToolName = (typeof ALL_TOOL_NAMES)[number];
