export interface McpProviderMetadata {
  /**
   * Default descriptions for tools exposed by the provider. Used when the MCP server does not return
   * rich metadata so the UI/LLM can still surface meaningful context.
   */
  defaultToolDescriptions?: Record<string, string>;
}

const atlassianDescriptions: Record<string, string> = {
  // Confluence tools
  confluence_get_page:
    'Retrieve a Confluence page by ID or search by title within a space. Include page metadata and optional content.',
  confluence_create_page:
    'Create a new Confluence page. Automatically uses your personal space when spaceId is omitted - no need to call confluence_get_current_user first.',
  confluence_update_page:
    'Update an existing Confluence page with new content and optional title change. Use the pageId from a previous tool call response (e.g., from confluence_create_page or confluence_get_page).',
  confluence_search:
    'Search for Confluence content using CQL with enhanced capabilities. Returns matching pages with highlighted excerpts, relevance ranking, and URLs. Uses Confluence API v1 for superior search functionality.',
  confluence_list_spaces: 'List available Confluence spaces with descriptions and homepage links.',
  confluence_get_space: 'Fetch details for a Confluence space by key, including homepage and metadata.',
  confluence_get_page_children: 'Retrieve child pages for a given Confluence page to understand hierarchy.',
  confluence_get_current_user:
    'Retrieve the currently authenticated Confluence user profile and personal space information. Returns user details including account ID, display name, and personal space metadata.',
  confluence_list_pages:
    'List all pages in a Confluence space. Use usePersonalSpace: true to automatically list pages from your personal space, provide a specific spaceId, or omit both to list pages from all accessible spaces.',
  confluence_delete_page:
    '⚠️ DESTRUCTIVE PREVIEW-FIRST TOOL: ALWAYS call TWICE. First call: MUST use confirmed=false (or omit) to show preview. Second call: Use confirmed=true ONLY after user explicitly confirms. PERMANENTLY deletes a Confluence page. Cannot be undone.',
  // Jira tools
  jira_get_issue:
    '[JIRA ONLY] Retrieve a Jira issue by key (e.g., PROJ-123, not #1). DO NOT use for GitHub issues - if user mentions owner/repo format, use GitHub tools instead. Returns issue details including summary, description, status, assignee, and custom fields.',
  jira_create_issue:
    '[JIRA ONLY] Create a new Jira issue. DO NOT use for GitHub repositories in owner/repo format. Requires project key, summary, issue type name. Optionally set description, priority, assignee, labels, and parent (for subtasks).',
  jira_update_issue:
    '[JIRA ONLY] Update an existing Jira issue. DO NOT use for GitHub issues or repositories in owner/repo format - use update_issue or update_project_item_fields instead. Can update summary, description, priority, labels, and other fields.',
  jira_search_issues:
    '[JIRA ONLY] Search for Jira issues using JQL (Jira Query Language). DO NOT use when user mentions GitHub repositories in owner/repo format. Returns matching issues with full details.',
  jira_list_projects:
    'List all accessible Jira projects. Returns project keys, names, and details. Use this to discover project keys when creating or updating issues.',
  jira_get_project: 'Get detailed information about a specific Jira project.',
  jira_list_issue_types:
    'List available issue types for a project (e.g., Task, Epic, Subtask). Use this to discover available issue type names, especially for projects with custom issue types.',
  jira_add_comment: 'Add a comment to a Jira issue.',
  jira_update_issue_transition:
    'Update/change the status of a Jira issue by specifying the target status name (e.g., move "To Do" → "In Progress", or "In Progress" → "Done"). Automatically looks up the correct transition and performs the status change. If the user provides context about why they are making this change or what they are doing with the issue, include that information in the comment parameter.',
  jira_assign_issue:
    '⚠️ PREVIEW-FIRST TOOL: ALWAYS call TWICE. First call: MUST use confirmed=false (or omit) to show preview. Second call: Use confirmed=true ONLY after user explicitly confirms. DO NOT set confirmed=true on first call. This assigns a Jira issue to a user.',
  jira_delete_issue:
    '⚠️ DESTRUCTIVE PREVIEW-FIRST TOOL: ALWAYS call TWICE. First call: MUST use confirmed=false (or omit) to show preview. Second call: Use confirmed=true ONLY after user explicitly confirms. PERMANENTLY deletes a Jira issue. Cannot be undone.',
  jira_get_current_user: 'Get information about the currently authenticated Jira user. Returns user account details.',
  jira_list_watchers:
    'Get all watchers for a Jira issue. Returns the list of users watching the issue and the total watcher count.',
  jira_add_watcher: "Add a user as a watcher to a Jira issue. Requires the user's Atlassian account ID.",
  jira_remove_watcher: "Remove a watcher from a Jira issue. Requires the user's Atlassian account ID.",
  // Jira Attachment tools
  jira_list_attachments:
    'List all attachments on a Jira issue. Returns filenames, sizes, MIME types, authors, and download URLs.',
  jira_upload_attachment:
    'Upload a file attachment to a Jira issue. Supports Slack files and base64-encoded content (max 20MB).',
  jira_download_attachment: 'Download a Jira attachment by ID. Returns base64-encoded content.',
  jira_delete_attachment:
    '⚠️ DESTRUCTIVE PREVIEW-FIRST TOOL: ALWAYS call TWICE. First call: MUST use confirmed=false (or omit) to show preview. Second call: Use confirmed=true ONLY after user explicitly confirms. Delete an attachment from a Jira issue.',
  // Confluence Attachment tools
  confluence_list_attachments: 'List all attachments on a Confluence page. Returns filenames, sizes, and MIME types.',
  confluence_upload_attachment:
    'Upload a file to a Confluence page. Supports Slack files and base64 (max 25MB). Auto-embeds in page.',
  confluence_download_attachment: 'Download a Confluence attachment by ID. Returns base64-encoded content.',
  confluence_delete_attachment:
    '⚠️ DESTRUCTIVE PREVIEW-FIRST TOOL: ALWAYS call TWICE. First call: MUST use confirmed=false (or omit) to show preview. Second call: Use confirmed=true ONLY after user explicitly confirms. Delete an attachment from a Confluence page.',
};

export const MCP_PROVIDER_METADATA: Record<string, McpProviderMetadata> = {
  atlassian: {
    defaultToolDescriptions: atlassianDescriptions,
  },
  github: {
    defaultToolDescriptions: {
      // Core GitHub tools (must match b4m-core/mcp/src/github/index.ts)
      create_issue:
        '[GITHUB ONLY] Create a new issue in a GitHub repository. Use when user mentions owner/repo format. DO NOT use jira_create_issue for GitHub repos. Requires repository owner, repository name, issue title, and optional body, labels, and assignees.',
      update_issue:
        '[GITHUB ONLY] Update an existing GitHub issue in owner/repo format. DO NOT use jira_update_issue for GitHub - jira_update_issue is ONLY for Jira issues with keys like PROJ-123. Can modify title, body, state (open/closed), labels, assignees, and issue type. Use list_org_issue_types to see available types. Requires repository owner, repository name, and issue number. IMPORTANT: DO NOT use this tool to update GitHub Projects v2 fields like Priority, Size, Iteration, Estimate, Start Date, Target Date, or Status - those are PROJECT FIELDS and require update_project_item_fields instead. This tool is ONLY for standard issue properties (title, body, state, labels, assignees).',
      list_issues:
        '[GITHUB ONLY] List issues for a GitHub repository in owner/repo format. DO NOT use jira_search_issues for GitHub. Can filter by state, labels, assignee, type. Returns issue details including title, body, status, and metadata.',
      get_issue:
        '[GITHUB ONLY] Get detailed information about a specific GitHub issue by number. Use when user mentions owner/repo and issue #1. DO NOT use jira_get_issue. Returns full issue details including body, comments count, milestone, timestamps, node_id (for Projects v2), and associated GitHub Projects.',
      search_code:
        'Search for code across GitHub repositories using GitHub code search syntax. Returns matching code snippets with file paths, line numbers, and repository information.',

      // Repository discovery and management
      list_repositories:
        'List all GitHub repositories accessible to the authenticated user. Supports filtering by visibility (public/private) and affiliation (owner/collaborator/organization_member). Returns repository metadata including name, description, language, stars, and activity.',
      get_repository:
        'Get detailed information about a specific GitHub repository. Returns comprehensive metadata including description, languages, topics, stars, forks, open issues, license, and activity timestamps.',

      // Pull request tools
      list_pull_requests:
        'List pull requests for a GitHub repository with optional state filter (open/closed/all). Returns PR details including title, state, draft status, author, branches, and merge status.',
      get_pull_request:
        'Get detailed information about a specific pull request including body, state, reviewers, commits, file changes, and merge status.',

      // Branch tools
      list_branches:
        'List all branches in a GitHub repository. Returns branch names, protection status, and latest commit information.',

      // Commit tools
      list_commits:
        'List commit history for a GitHub repository with optional filters (branch, file path, author). Returns commit SHA, message, author, date, and statistics.',
      get_commit:
        'Get detailed information about a specific commit including full message, author, committer, file changes, and diff statistics.',

      list_org_issue_types:
        'List available native GitHub issue types for an organization (Bug, Feature, Task, etc.). Use this to discover what issue types can be set on issues in the organization.',

      // GitHub Projects v2 tools
      list_org_projects:
        'List all GitHub Projects (v2) for an organization. Returns project IDs, titles, descriptions, and URLs. Use this to discover available projects before managing project fields.',
      list_project_fields:
        'List all fields for a GitHub Project (Status, Priority, Size, Iteration, etc.). Returns field IDs, data types, and available options (for single-select fields). Required to get field IDs and option IDs before updating project item fields.',
      get_project_item:
        'Get a GitHub issue as a project item. CRITICAL: This returns the item_id (starts with PVTI_) that you MUST use for update_project_item_fields - DO NOT use the issue node_id (starts with I_) from get_issue. WORKFLOW: Always call this BEFORE update_project_item_fields to get the correct item_id. If this tool returns an error (issue not in project), you must call add_issue_to_project first. Returns current field values and the item_id (PVTI_) needed for updates.',
      add_issue_to_project:
        '⚠️ PREVIEW-FIRST TOOL: Add a GitHub issue to a project. CRITICAL: Call this when get_project_item fails (issue not in project yet). After adding, call get_project_item to get the item_id (PVTI_) before updating fields. Use get_issue to get the issue node_id first. IMPORTANT: Always include display parameters for human-readable preview: display_project_name (from list_org_projects), display_issue_title (from get_issue like "#2 - Login issue"), and display_repository (from get_issue like "owner/repo"). Returns the new project item ID.',
      update_project_item_fields:
        '⚠️ PREVIEW-FIRST TOOL: ALWAYS call TWICE. Update one or more fields on a GitHub Project item (Priority, Size, Iteration, Estimate, Start Date, Target Date, Status). USE THIS TOOL when user asks to update Priority, Size, Iteration, Estimate, Start Date, Target Date, or Status on an issue that belongs to a GitHub Project - these are PROJECT FIELDS, not issue labels or properties. Supports both single field updates and batch updates. WORKFLOW: (1) Call get_project_item to get the item_id (starts with PVTI_) - if this fails, the issue is not in the project yet, so call add_issue_to_project first. (2) Call list_project_fields to get field IDs. (3) Call update_project_item_fields with the PVTI_ item_id. CRITICAL: The item_id parameter MUST be a ProjectV2Item ID (starts with PVTI_) from get_project_item, NOT the issue node_id (starts with I_) from get_issue. Using the wrong ID will cause all updates to fail. For each field in updates array, provide: field_id, value (actual ID/number/date), field_name (human name), new_value (human-readable for preview). Example: {item_id: "PVTI_lADO...", updates: [{field_id: "PVTF_...", value: "option_id", field_name: "Priority", new_value: "P1"}]}',

      // Legacy tool names (for backwards compatibility)
      github_list_repositories: 'List GitHub repositories accessible to the connected account.',
      github_get_repository: 'Fetch detailed information about a specific GitHub repository.',
      github_create_issue: 'Create a new issue in a GitHub repository.',
      github_list_issues: 'List issues for a GitHub repository with optional filters.',
    },
  },
};

export const getMcpProviderMetadata = (providerName: string): McpProviderMetadata | undefined => {
  return MCP_PROVIDER_METADATA[providerName.toLowerCase()];
};
