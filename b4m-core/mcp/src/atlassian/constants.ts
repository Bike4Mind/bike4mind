/**
 * Atlassian MCP Server - Constants
 *
 * Tool names and other constants used across the Atlassian MCP server.
 */

// ============================================================================
// Jira Tools
// ============================================================================

export const JIRA_GET_ISSUE = 'jira_get_issue' as const;
export const JIRA_CREATE_ISSUE = 'jira_create_issue' as const;
export const JIRA_BULK_CREATE_ISSUES = 'jira_bulk_create_issues' as const;
export const JIRA_BULK_TRANSITION_ISSUES = 'jira_bulk_transition_issues' as const;
export const JIRA_BULK_UPDATE_ISSUES = 'jira_bulk_update_issues' as const;
export const JIRA_UPDATE_ISSUE = 'jira_update_issue' as const;
export const JIRA_SEARCH_ISSUES = 'jira_search_issues' as const;
export const JIRA_LIST_PROJECTS = 'jira_list_projects' as const;
export const JIRA_GET_PROJECT = 'jira_get_project' as const;
export const JIRA_LIST_ISSUE_TYPES = 'jira_list_issue_types' as const;
export const JIRA_LIST_PROJECT_MEMBERS = 'jira_list_project_members' as const;
export const JIRA_ADD_COMMENT = 'jira_add_comment' as const;
export const JIRA_GET_TRANSITIONS = 'jira_get_transitions' as const;
export const JIRA_UPDATE_ISSUE_TRANSITION = 'jira_update_issue_transition' as const;
export const JIRA_ASSIGN_ISSUE = 'jira_assign_issue' as const;
export const JIRA_DELETE_ISSUE = 'jira_delete_issue' as const;
export const JIRA_GET_CURRENT_USER = 'jira_get_current_user' as const;
export const JIRA_SEARCH_USERS = 'jira_search_users' as const;
export const JIRA_LIST_WATCHERS = 'jira_list_watchers' as const;
export const JIRA_ADD_WATCHER = 'jira_add_watcher' as const;
export const JIRA_REMOVE_WATCHER = 'jira_remove_watcher' as const;
export const JIRA_LIST_LINK_TYPES = 'jira_list_link_types' as const;
export const JIRA_LIST_ISSUE_LINKS = 'jira_list_issue_links' as const;
export const JIRA_CREATE_ISSUE_LINK = 'jira_create_issue_link' as const;
export const JIRA_CREATE_ISSUE_LINKS = 'jira_create_issue_links' as const;
export const JIRA_DELETE_ISSUE_LINK = 'jira_delete_issue_link' as const;

// Jira Attachment Tools
export const JIRA_LIST_ATTACHMENTS = 'jira_list_attachments' as const;
export const JIRA_UPLOAD_ATTACHMENT = 'jira_upload_attachment' as const;
export const JIRA_DOWNLOAD_ATTACHMENT = 'jira_download_attachment' as const;
export const JIRA_DELETE_ATTACHMENT = 'jira_delete_attachment' as const;

// Jira Agile Tools
export const JIRA_LIST_BOARDS = 'jira_list_boards' as const;
export const JIRA_GET_BOARD = 'jira_get_board' as const;
export const JIRA_LIST_SPRINTS = 'jira_list_sprints' as const;
export const JIRA_GET_SPRINT = 'jira_get_sprint' as const;
export const JIRA_CREATE_SPRINT = 'jira_create_sprint' as const;
export const JIRA_UPDATE_SPRINT = 'jira_update_sprint' as const;
export const JIRA_GET_SPRINT_ISSUES = 'jira_get_sprint_issues' as const;
export const JIRA_MOVE_ISSUES_TO_SPRINT = 'jira_move_issues_to_sprint' as const;
export const JIRA_GET_BOARD_CONFIGURATION = 'jira_get_board_configuration' as const;
export const JIRA_GET_BOARD_ISSUES = 'jira_get_board_issues' as const;

// ============================================================================
// Confluence Tools
// ============================================================================

export const CONFLUENCE_GET_PAGE = 'confluence_get_page' as const;
export const CONFLUENCE_CREATE_PAGE = 'confluence_create_page' as const;
export const CONFLUENCE_UPDATE_PAGE = 'confluence_update_page' as const;
export const CONFLUENCE_DELETE_PAGE = 'confluence_delete_page' as const;
export const CONFLUENCE_SEARCH = 'confluence_search' as const;
export const CONFLUENCE_LIST_SPACES = 'confluence_list_spaces' as const;
export const CONFLUENCE_GET_SPACE = 'confluence_get_space' as const;
export const CONFLUENCE_GET_PAGE_CHILDREN = 'confluence_get_page_children' as const;
export const CONFLUENCE_GET_CURRENT_USER = 'confluence_get_current_user' as const;
export const CONFLUENCE_LIST_PAGES = 'confluence_list_pages' as const;
export const CONFLUENCE_GET_PAGE_RESTRICTIONS = 'confluence_get_page_restrictions' as const;
export const CONFLUENCE_ADD_PAGE_RESTRICTION = 'confluence_add_page_restriction' as const;
export const CONFLUENCE_REMOVE_PAGE_RESTRICTION = 'confluence_remove_page_restriction' as const;
export const CONFLUENCE_CREATE_COMMENT = 'confluence_create_comment' as const;
export const CONFLUENCE_REPLY_TO_COMMENT = 'confluence_reply_to_comment' as const;
export const CONFLUENCE_LIST_COMMENTS = 'confluence_list_comments' as const;
export const CONFLUENCE_GET_COMMENT = 'confluence_get_comment' as const;
export const CONFLUENCE_UPDATE_COMMENT = 'confluence_update_comment' as const;
export const CONFLUENCE_DELETE_COMMENT = 'confluence_delete_comment' as const;

// Confluence Attachment Tools
export const CONFLUENCE_LIST_ATTACHMENTS = 'confluence_list_attachments' as const;
export const CONFLUENCE_UPLOAD_ATTACHMENT = 'confluence_upload_attachment' as const;
export const CONFLUENCE_DOWNLOAD_ATTACHMENT = 'confluence_download_attachment' as const;
export const CONFLUENCE_DELETE_ATTACHMENT = 'confluence_delete_attachment' as const;

// ============================================================================
// Tool Categories (sub-categorized)
// ============================================================================

export const JIRA_ISSUE_TOOLS = [
  JIRA_GET_ISSUE,
  JIRA_CREATE_ISSUE,
  JIRA_BULK_CREATE_ISSUES,
  JIRA_UPDATE_ISSUE,
  JIRA_BULK_UPDATE_ISSUES,
  JIRA_SEARCH_ISSUES,
  JIRA_DELETE_ISSUE,
] as const;

export const JIRA_PROJECT_TOOLS = [
  JIRA_LIST_PROJECTS,
  JIRA_GET_PROJECT,
  JIRA_LIST_ISSUE_TYPES,
  JIRA_LIST_PROJECT_MEMBERS,
] as const;

export const JIRA_WORKFLOW_TOOLS = [
  JIRA_ADD_COMMENT,
  JIRA_GET_TRANSITIONS,
  JIRA_UPDATE_ISSUE_TRANSITION,
  JIRA_BULK_TRANSITION_ISSUES,
  JIRA_ASSIGN_ISSUE,
] as const;

export const JIRA_USER_TOOLS = [
  JIRA_GET_CURRENT_USER,
  JIRA_SEARCH_USERS,
  JIRA_LIST_WATCHERS,
  JIRA_ADD_WATCHER,
  JIRA_REMOVE_WATCHER,
] as const;

export const JIRA_LINK_TOOLS = [
  JIRA_LIST_LINK_TYPES,
  JIRA_LIST_ISSUE_LINKS,
  JIRA_CREATE_ISSUE_LINK,
  JIRA_CREATE_ISSUE_LINKS,
  JIRA_DELETE_ISSUE_LINK,
] as const;

export const JIRA_ATTACHMENT_TOOLS = [
  JIRA_LIST_ATTACHMENTS,
  JIRA_UPLOAD_ATTACHMENT,
  JIRA_DOWNLOAD_ATTACHMENT,
  JIRA_DELETE_ATTACHMENT,
] as const;

export const JIRA_AGILE_TOOLS = [
  JIRA_LIST_BOARDS,
  JIRA_GET_BOARD,
  JIRA_LIST_SPRINTS,
  JIRA_GET_SPRINT,
  JIRA_CREATE_SPRINT,
  JIRA_UPDATE_SPRINT,
  JIRA_GET_SPRINT_ISSUES,
  JIRA_MOVE_ISSUES_TO_SPRINT,
  JIRA_GET_BOARD_CONFIGURATION,
  JIRA_GET_BOARD_ISSUES,
] as const;

export const CONFLUENCE_PAGE_TOOLS = [
  CONFLUENCE_GET_PAGE,
  CONFLUENCE_CREATE_PAGE,
  CONFLUENCE_UPDATE_PAGE,
  CONFLUENCE_DELETE_PAGE,
  CONFLUENCE_SEARCH,
  CONFLUENCE_LIST_SPACES,
  CONFLUENCE_GET_SPACE,
  CONFLUENCE_GET_PAGE_CHILDREN,
  CONFLUENCE_GET_CURRENT_USER,
  CONFLUENCE_LIST_PAGES,
] as const;

export const CONFLUENCE_COMMENT_TOOLS = [
  CONFLUENCE_CREATE_COMMENT,
  CONFLUENCE_REPLY_TO_COMMENT,
  CONFLUENCE_LIST_COMMENTS,
  CONFLUENCE_GET_COMMENT,
  CONFLUENCE_UPDATE_COMMENT,
  CONFLUENCE_DELETE_COMMENT,
] as const;

export const CONFLUENCE_RESTRICTION_TOOLS = [
  CONFLUENCE_GET_PAGE_RESTRICTIONS,
  CONFLUENCE_ADD_PAGE_RESTRICTION,
  CONFLUENCE_REMOVE_PAGE_RESTRICTION,
] as const;

export const CONFLUENCE_ATTACHMENT_TOOLS = [
  CONFLUENCE_LIST_ATTACHMENTS,
  CONFLUENCE_UPLOAD_ATTACHMENT,
  CONFLUENCE_DOWNLOAD_ATTACHMENT,
  CONFLUENCE_DELETE_ATTACHMENT,
] as const;

// Flat aggregate arrays (for startup logging)
export const JIRA_TOOLS = [
  ...JIRA_ISSUE_TOOLS,
  ...JIRA_PROJECT_TOOLS,
  ...JIRA_WORKFLOW_TOOLS,
  ...JIRA_USER_TOOLS,
  ...JIRA_LINK_TOOLS,
  ...JIRA_ATTACHMENT_TOOLS,
  ...JIRA_AGILE_TOOLS,
] as const;

export const CONFLUENCE_TOOLS = [
  ...CONFLUENCE_PAGE_TOOLS,
  ...CONFLUENCE_COMMENT_TOOLS,
  ...CONFLUENCE_RESTRICTION_TOOLS,
  ...CONFLUENCE_ATTACHMENT_TOOLS,
] as const;

export const TOOL_CATEGORIES = {
  'Jira Issues': JIRA_ISSUE_TOOLS,
  'Jira Projects': JIRA_PROJECT_TOOLS,
  'Jira Workflows': JIRA_WORKFLOW_TOOLS,
  'Jira Users': JIRA_USER_TOOLS,
  'Jira Links': JIRA_LINK_TOOLS,
  'Jira Attachments': JIRA_ATTACHMENT_TOOLS,
  'Jira Agile': JIRA_AGILE_TOOLS,
  'Confluence Pages': CONFLUENCE_PAGE_TOOLS,
  'Confluence Comments': CONFLUENCE_COMMENT_TOOLS,
  'Confluence Restrictions': CONFLUENCE_RESTRICTION_TOOLS,
  'Confluence Attachments': CONFLUENCE_ATTACHMENT_TOOLS,
} as const;

// All tool names for validation
export const ALL_ATLASSIAN_TOOL_NAMES = [...JIRA_TOOLS, ...CONFLUENCE_TOOLS];

export type AtlassianToolName = (typeof ALL_ATLASSIAN_TOOL_NAMES)[number];
