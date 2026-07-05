// Jira API client for OAuth-authenticated operations
// Uses Jira REST API v3

import { detectMimeType as _detectMimeType } from '../utils';
import { parseRateLimitHeaders, isNearLimit, hasRateLimitInfo, buildRateLimitLogEntry } from '../rateLimitHeaders';

import {
  formatIssueResponse,
  formatProjectResponse,
  formatIssueDetails,
  formatSearchResults,
  formatProjectList,
  formatComment,
  formatTransitions,
  formatUser,
  formatUserList,
  formatTransitionResult,
  formatWatchers,
  formatIssueLinkTypes,
  formatIssueLinks,
  formatProjectRoles,
  formatProjectRoleMembers,
  type FormattedRoleMember,
  type FormattedJiraSearchResults,
  type FormattedJiraProject,
  type FormattedJiraProjectListItem,
  type FormattedJiraComment,
  type FormattedJiraTransitions,
  type FormattedJiraIssueLinkType,
  type FormattedJiraIssueLink,
  type FormattedJiraIssueType,
} from './format';
import { AgileApi } from './agile/api';

// --- Types & Interfaces ---

export type JiraEnvKeys = {
  accessToken: string;
  cloudId: string;
  siteUrl: string;
};

export interface JiraConfig extends JiraEnvKeys {
  webBaseUrl: string;
  apiBaseUrl: string;
  agileApiBaseUrl: string;
  authHeader: string;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: any;
    status: {
      name: string;
      id: string;
    };
    issuetype: {
      name: string;
      id: string;
    };
    project: {
      key: string;
      name: string;
      id: string;
    };
    assignee?: {
      displayName: string;
      accountId: string;
      accountType?: string;
    };
    reporter?: {
      displayName: string;
      accountId: string;
    };
    created: string;
    updated: string;
    [key: string]: any;
  };
}

/**
 * Shape returned by formatIssueDetails() - flattened from JiraIssue.
 * searchIssues() returns these at runtime, not raw JiraIssue objects.
 */
export interface FormattedJiraIssue {
  id: string;
  key: string;
  link: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority?: string;
  assignee: { accountId: string; displayName: string; accountType?: string } | null;
  reporter: { accountId: string; displayName: string } | null;
  created?: string;
  updated?: string;
  project?: { key: string; name: string };
  labels?: string[];
  subtasks?: { id: string; key: string; link: string }[];
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  style: string;
  self: string;
  description?: string;
  lead?: {
    displayName: string;
    accountId: string;
  };
  issueTypes?: JiraIssueType[];
}

export interface JiraIssueType {
  id: string;
  name: string;
  description: string;
  subtask: boolean;
  self: string;
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
  /** Cursor token for the next page (new /search/jql endpoint) */
  nextPageToken?: string;
}

export interface JiraComment {
  id: string;
  body: any;
  author: {
    displayName: string;
    accountId: string;
  };
  created: string;
  updated: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  accountType?: string;
}

export interface JiraWatchersResponse {
  self: string;
  isWatching: boolean;
  watchCount: number;
  watchers: JiraUser[];
}

// --- Project Role Types ---

export interface JiraRoleActor {
  id: number;
  displayName: string;
  type: string;
  name?: string;
  actorUser?: {
    accountId: string;
  };
  actorGroup?: {
    name: string;
    displayName: string;
  };
}

export interface JiraProjectRole {
  self: string;
  name: string;
  id: number;
  description: string;
  actors: JiraRoleActor[];
}

// --- Attachment Types ---

export interface JiraAttachment {
  id: string;
  self: string;
  filename: string;
  author: {
    accountId: string;
    displayName: string;
  };
  created: string;
  size: number;
  mimeType: string;
  content: string; // URL to download the attachment
  thumbnail?: string; // URL for thumbnail (images only)
}

export interface JiraAttachmentUploadResponse {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  created: string;
  self: string;
  content: string;
}

/**
 * Maximum attachment size in bytes (20MB default)
 */
export const JIRA_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

// Re-export shared MIME type utilities for backwards compatibility
export { MIME_TYPE_MAP, detectMimeType } from '../utils';

// --- Issue Link Types ---

export interface JiraIssueLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
  self?: string;
}

export interface JiraIssueLinkTypesResponse {
  issueLinkTypes: JiraIssueLinkType[];
}

export interface JiraLinkedIssue {
  id: string;
  key: string;
  self?: string;
  fields: {
    summary: string;
    status: {
      id: string;
      name: string;
      statusCategory?: { key: string; name: string };
    };
    priority?: { id: string; name: string };
    issuetype?: { id: string; name: string };
  };
}

export interface JiraIssueLink {
  id: string;
  self?: string;
  type: JiraIssueLinkType;
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
}

/**
 * Validates that a string is a valid Jira project key format.
 * Project keys: uppercase letters, digits, underscores (e.g., PROJ, MY_APP2)
 */
export const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]*$/i;

export function isValidProjectKey(key: string): boolean {
  return JIRA_PROJECT_KEY_RE.test(key);
}

/**
 * Validates that a string is a valid Jira issue key format.
 * Issue keys must be: PROJECT-NUMBER (e.g., PROJ-123, ABC-1, A1-999)
 */
export function isValidIssueKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]*-\d+$/.test(key);
}

// --- Wiki Markup to ADF Conversion ---

/**
 * ADF (Atlassian Document Format) types for building rich content
 */
interface AdfTextNode {
  type: 'text';
  text: string;
}

interface AdfParagraph {
  type: 'paragraph';
  content: AdfTextNode[];
}

interface AdfTableCell {
  type: 'tableCell' | 'tableHeader';
  attrs: Record<string, unknown>;
  content: AdfParagraph[];
}

interface AdfTableRow {
  type: 'tableRow';
  content: AdfTableCell[];
}

interface AdfTable {
  type: 'table';
  attrs: { isNumberColumnEnabled: boolean; layout: string };
  content: AdfTableRow[];
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: (AdfParagraph | AdfTable)[];
}

/**
 * Convert Jira wiki markup to ADF (Atlassian Document Format)
 * Handles tables (||header|| and |cell|) and plain text paragraphs
 *
 * Exported for testing purposes
 */
export function wikiMarkupToAdf(text: string): AdfDocument {
  const lines = text.split('\n');
  const content: (AdfParagraph | AdfTable)[] = [];
  let currentTableRows: AdfTableRow[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check if this is a table header row (||Header||)
    if (trimmedLine.startsWith('||') && trimmedLine.endsWith('||')) {
      inTable = true;
      const cells = trimmedLine
        .slice(2, -2) // Remove leading and trailing ||
        .split('||')
        .map(cell => cell.trim());

      const headerRow: AdfTableRow = {
        type: 'tableRow',
        content: cells.map(cell => ({
          type: 'tableHeader',
          attrs: {},
          content: [{ type: 'paragraph', content: [{ type: 'text', text: cell || ' ' }] }],
        })),
      };
      currentTableRows.push(headerRow);
      continue;
    }

    // Check if this is a table data row (|Value|)
    if (trimmedLine.startsWith('|') && trimmedLine.endsWith('|') && !trimmedLine.startsWith('||')) {
      inTable = true;
      const cells = trimmedLine
        .slice(1, -1) // Remove leading and trailing |
        .split('|')
        .map(cell => cell.trim());

      const dataRow: AdfTableRow = {
        type: 'tableRow',
        content: cells.map(cell => ({
          type: 'tableCell',
          attrs: {},
          content: [{ type: 'paragraph', content: [{ type: 'text', text: cell || ' ' }] }],
        })),
      };
      currentTableRows.push(dataRow);
      continue;
    }

    // Not a table line - if we were in a table, finalize it
    if (inTable && currentTableRows.length > 0) {
      const table: AdfTable = {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: currentTableRows,
      };
      content.push(table);
      currentTableRows = [];
      inTable = false;
    }

    // Add non-empty lines as paragraphs
    if (trimmedLine) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: trimmedLine }],
      });
    }
  }

  // Finalize any remaining table
  if (currentTableRows.length > 0) {
    const table: AdfTable = {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: currentTableRows,
    };
    content.push(table);
  }

  // Ensure at least one paragraph if empty
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: ' ' }] });
  }

  return { type: 'doc', version: 1, content };
}

/**
 * Check if text contains Jira wiki markup tables
 *
 * Exported for testing purposes
 */
export function containsWikiTable(text: string): boolean {
  // Match header rows: ||Header1||Header2||
  // Match data rows: |Value1|Value2| (starts with single |, not ||)
  return /^\|\|.+\|\|$/m.test(text) || /^\|(?!\|).+\|$/m.test(text);
}

// --- Jira API Client ---

export class JiraApi {
  constructor(private readonly config: JiraConfig) {}

  /**
   * Build URL with query parameters
   */
  private buildUrl(path: string, query: QueryParams = {}): string {
    const base = `${this.config.apiBaseUrl}${path}`;
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === '') return;
      url.searchParams.append(key, String(value));
    });
    return url.toString();
  }

  /**
   * Build web URL for Jira UI links
   */
  public buildWebUrl(path: string): string {
    if (!path) return '';
    // Remove leading slash if present
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${this.config.webBaseUrl}/${cleanPath}`;
  }

  /**
   * Make authenticated HTTP request
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown; _retryCount?: number } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: this.config.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Parse rate limit headers from every response.
    // MUST use console.error (stderr) - MCP uses stdout for JSON-RPC protocol,
    // so console.log would corrupt the transport channel.
    const rateLimitInfo = parseRateLimitHeaders(response.headers);
    if (hasRateLimitInfo(rateLimitInfo)) {
      const logEntry = buildRateLimitLogEntry('jira', path, rateLimitInfo);
      console.error(JSON.stringify(logEntry));
      if (isNearLimit(rateLimitInfo)) {
        console.error(
          `[Jira] Rate limit warning: ${rateLimitInfo.usagePercent}% used (${rateLimitInfo.remaining}/${rateLimitInfo.limit} remaining)`
        );
      }
    }

    // Handle 429 Too Many Requests with single retry
    if (response.status === 429 && (options._retryCount ?? 0) < 1) {
      // Default 5s: conservative middle ground - Atlassian docs suggest retry windows of 1-10s,
      // and 5s avoids hammering while staying well under Lambda's execution budget.
      const retryAfterMs = rateLimitInfo.retryAfterMs ?? 5000;
      // Add jitter (0-1s) to prevent thundering herd when multiple requests retry simultaneously
      const jitterMs = Math.floor(Math.random() * 1000);
      const delayMs = Math.min(retryAfterMs + jitterMs, 10000); // Cap at 10s for Lambda budget
      const logEntry = buildRateLimitLogEntry('jira', path, rateLimitInfo, true);
      console.error(JSON.stringify(logEntry));
      console.error(`[Jira] Rate limited on ${path}, retrying after ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return this.request<T>(method, path, {
        ...options,
        _retryCount: (options._retryCount ?? 0) + 1,
      });
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Jira API error (${response.status}): ${errorBody}`);
    }

    // 204 No Content responses don't have a body
    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json();
    return data as T;
  }

  // --- High-Level API Methods ---

  /**
   * Get issue by key or ID
   */
  async getIssue(params: { issueKey: string; expand?: string[] }): Promise<FormattedJiraIssue> {
    const { issueKey, expand } = params;
    const issue = await this.request<JiraIssue>('GET', `/issue/${issueKey}`, {
      query: {
        expand: expand?.join(','),
      },
    });
    return formatIssueDetails(issue, this.config.siteUrl);
  }

  /**
   * Create a new issue
   */
  async createIssue(params: {
    projectKey: string;
    summary: string;
    description?: string;
    issueTypeName: string;
    assignee?: string;
    labels?: string[];
    parentKey?: string;
    [key: string]: any;
  }): Promise<{ id: string; key: string; link: string }> {
    const { projectKey, summary, description, issueTypeName, assignee, labels, parentKey, ...customFields } = params;

    const fields: any = {
      project: { key: projectKey },
      summary,
      issuetype: { name: issueTypeName },
      ...customFields,
    };

    if (description) {
      // Convert wiki markup tables to ADF format for proper rendering
      if (containsWikiTable(description)) {
        console.log('[JIRA-ADF] Converting wiki table to ADF', { length: description.length });
        fields.description = wikiMarkupToAdf(description);
      } else {
        fields.description = {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: description }],
            },
          ],
        };
      }
    }

    if (assignee) {
      fields.assignee = { id: assignee };
    }

    if (labels && labels.length > 0) {
      fields.labels = labels;
    }

    if (parentKey) {
      fields.parent = { key: parentKey };
    }

    const result = await this.request<JiraIssue>('POST', '/issue', {
      body: { fields },
    });

    return formatIssueResponse(result, this.config.siteUrl);
  }

  /**
   * Update an existing issue
   */
  async updateIssue(params: {
    issueKey: string;
    summary?: string;
    description?: string;
    labels?: string[];
    [key: string]: any;
  }): Promise<void> {
    const { issueKey, summary, description, labels, ...customFields } = params;

    const fields: any = { ...customFields };

    if (summary) {
      fields.summary = summary;
    }

    if (description) {
      // Convert wiki markup tables to ADF format for proper rendering
      if (containsWikiTable(description)) {
        console.log('[JIRA-ADF] Converting wiki table to ADF (update)', { length: description.length });
        fields.description = wikiMarkupToAdf(description);
      } else {
        fields.description = {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: description }],
            },
          ],
        };
      }
    }

    if (labels && labels.length > 0) {
      fields.labels = labels;
    }

    // Only send request if there are fields to update
    if (Object.keys(fields).length > 0) {
      await this.request<void>('PUT', `/issue/${issueKey}`, {
        body: { fields },
      });
    }
  }

  /**
   * Search for issues using JQL, returning the RAW Jira response (unformatted).
   *
   * Use this for server-side analytics/automation that need raw `fields` the
   * AI-facing formatter drops or transforms - e.g. time-tracking
   * (`timespent`/`timeoriginalestimate`), `resolutiondate`, or the original
   * description body (the formatter flattens ADF and strips HTML, which would
   * destroy embedded markers such as the liveops `<!-- fingerprint:... -->` comment).
   * Prefer {@link searchIssues} for anything user/LLM-facing.
   */
  async searchIssuesRaw(params: {
    jql: string;
    startAt?: number;
    maxResults?: number;
    fields?: string[];
    expand?: string[];
    /** Cursor token for the next page (replaces startAt on /search/jql) */
    nextPageToken?: string;
  }): Promise<JiraSearchResult> {
    const { jql, startAt = 0, maxResults = 50, fields, expand, nextPageToken } = params;

    // New /search/jql endpoint uses nextPageToken for pagination (startAt is deprecated)
    return this.request<JiraSearchResult>('GET', '/search/jql', {
      query: {
        jql,
        ...(nextPageToken ? { nextPageToken } : { startAt }),
        maxResults,
        fields: fields?.join(',') || '*all',
        expand: expand?.join(','),
      },
    });
  }

  /**
   * Search for issues using JQL, returning AI-facing formatted (flattened) issues.
   */
  async searchIssues(params: {
    jql: string;
    startAt?: number;
    maxResults?: number;
    fields?: string[];
    expand?: string[];
    /** Cursor token for the next page (replaces startAt on /search/jql) */
    nextPageToken?: string;
  }): Promise<FormattedJiraSearchResults> {
    const result = await this.searchIssuesRaw(params);
    return formatSearchResults(result, this.config.siteUrl);
  }

  /**
   * List all accessible projects
   */
  async listProjects(params?: {
    maxResults?: number;
    query?: string;
    expand?: string;
  }): Promise<FormattedJiraProjectListItem[]> {
    // /project/search returns a paginated wrapper { values: [...] }, not a bare array.
    const projects = await this.request<{ values?: JiraProject[] }>('GET', '/project/search', {
      query: {
        maxResults: params?.maxResults,
        query: params?.query,
        expand: params?.expand,
      },
    });
    return formatProjectList(projects, this.config.siteUrl);
  }

  /**
   * Get project details
   */
  async getProject(params: { projectKey: string; expand?: string[] }): Promise<FormattedJiraProject> {
    const { projectKey, expand } = params;
    const project = await this.request<JiraProject>('GET', `/project/${projectKey}`, {
      query: {
        expand: expand?.join(','),
      },
    });

    return formatProjectResponse(project, this.config.siteUrl);
  }

  /**
   * List issue types for a project
   */
  async listIssueTypes(params: { projectKey: string }): Promise<FormattedJiraIssueType[]> {
    const { projectKey } = params;
    const project = await this.getProject({ projectKey, expand: ['issueTypes'] });
    return project.issueTypes || [];
  }

  /**
   * Add comment to an issue
   */
  async addComment(params: { issueKey: string; body: string }): Promise<FormattedJiraComment> {
    const { issueKey, body } = params;

    const comment = await this.request<JiraComment>('POST', `/issue/${issueKey}/comment`, {
      body: {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: body }],
            },
          ],
        },
      },
    });

    return formatComment(comment);
  }

  /**
   * Get all statuses available in a project, grouped by issue type.
   * Uses GET /project/{projectKey}/statuses which returns every workflow status.
   */
  async getProjectStatuses(params: { projectKey: string }): Promise<string[]> {
    const { projectKey } = params;
    const result = await this.request<Array<{ statuses: Array<{ name: string; id: string }> }>>(
      'GET',
      `/project/${projectKey}/statuses`
    );

    // Flatten and deduplicate status names across all issue types
    const names = new Set<string>();
    for (const issueType of result) {
      for (const status of issueType.statuses) {
        names.add(status.name);
      }
    }
    return Array.from(names).sort();
  }

  /**
   * Get available transitions for an issue
   */
  async getTransitions(params: { issueKey: string }): Promise<FormattedJiraTransitions> {
    const { issueKey } = params;
    const result = await this.request<{ transitions: JiraTransition[] }>('GET', `/issue/${issueKey}/transitions`);
    return formatTransitions(result);
  }

  /**
   * Transition issue to a new status
   */
  async transitionIssue(params: {
    issueKey: string;
    transitionId: string;
  }): Promise<{ issueKey: string; transitionId: string; link: string }> {
    const { issueKey, transitionId } = params;

    await this.request<void>('POST', `/issue/${issueKey}/transitions`, {
      body: {
        transition: { id: transitionId },
      },
    });

    // Format the result with a clickable link using the formatter
    const result = { issueKey, transitionId };
    return formatTransitionResult(result, this.config.siteUrl);
  }

  /**
   * Assign issue to a user
   */
  async assignIssue(params: { issueKey: string; accountId: string }): Promise<void> {
    const { issueKey, accountId } = params;
    await this.request<void>('PUT', `/issue/${issueKey}/assignee`, {
      body: { accountId },
    });
  }

  /**
   * Delete an issue
   */
  async deleteIssue(params: { issueKey: string }): Promise<void> {
    const { issueKey } = params;

    if (!issueKey) {
      throw new Error('issueKey is required to delete an issue.');
    }

    await this.request<void>('DELETE', `/issue/${issueKey}`);
  }

  /**
   * Get current user information
   */
  async getCurrentUser(): Promise<JiraUser> {
    const user = await this.request<JiraUser>('GET', '/myself');
    return formatUser(user);
  }

  /**
   * Search for users by query string (name, email, username)
   */
  async searchUsers(params: { query: string; maxResults?: number }): Promise<JiraUser[]> {
    const { query, maxResults = 50 } = params;

    const users = await this.request<JiraUser[]>('GET', '/user/search', {
      query: {
        query,
        maxResults,
      },
    });

    return formatUserList(users);
  }

  /**
   * Find users assignable to issues in a specific project.
   * Uses GET /user/assignable/search?project=KEY which respects
   * project permissions and roles.
   */
  async findAssignableUsers(params: { projectKey: string; maxResults?: number }): Promise<JiraUser[]> {
    const pageSize = 50;
    const maxTotal = params.maxResults ?? 500;
    const allUsers: JiraUser[] = [];
    let startAt = 0;

    while (allUsers.length < maxTotal) {
      const page = await this.request<JiraUser[]>('GET', '/user/assignable/search', {
        query: { project: params.projectKey, startAt, maxResults: pageSize },
      });

      if (!page || page.length === 0) break;

      for (const u of page) {
        if (u.active && u.accountType === 'atlassian') {
          allUsers.push(u);
        }
      }

      if (page.length < pageSize) break;
      startAt += pageSize;
    }

    return formatUserList(allUsers);
  }

  /**
   * Bulk create multiple issues in a single API call.
   * Supports up to 50 issues per request (Jira API limit).
   * Ideal for creating multiple subtasks under a parent issue.
   */
  async bulkCreateIssues(params: {
    issues: Array<{
      projectKey: string;
      summary: string;
      description?: string;
      issueTypeName: string;
      assignee?: string;
      labels?: string[];
      parentKey?: string;
    }>;
  }): Promise<{
    issues: Array<{ id: string; key: string; link: string }>;
    errors: Array<{ status: number; message: string; failedElementNumber: number }>;
  }> {
    const { issues } = params;

    if (issues.length === 0) {
      return { issues: [], errors: [] };
    }

    if (issues.length > 50) {
      throw new Error('Bulk create is limited to 50 issues per request. Please split your request.');
    }

    // Build the issueUpdates array for the bulk API
    const issueUpdates = issues.map(issue => {
      const { projectKey, summary, description, issueTypeName, assignee, labels, parentKey } = issue;

      const fields: any = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueTypeName },
      };

      if (description) {
        // Convert wiki markup tables to ADF format for proper rendering
        if (containsWikiTable(description)) {
          console.log('[JIRA-ADF] Converting wiki table to ADF (bulk)', { length: description.length });
          fields.description = wikiMarkupToAdf(description);
        } else {
          fields.description = {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: description }],
              },
            ],
          };
        }
      }

      if (assignee) {
        fields.assignee = { id: assignee };
      }

      if (labels && labels.length > 0) {
        fields.labels = labels;
      }

      if (parentKey) {
        fields.parent = { key: parentKey };
      }

      return { update: {}, fields };
    });

    const result = await this.request<{
      issues: Array<{ id: string; key: string; self: string }>;
      errors: Array<{ status: number; elementErrors: { errors: Record<string, string> }; failedElementNumber: number }>;
    }>('POST', '/issue/bulk', {
      body: { issueUpdates },
    });

    // Format the successful issues with links
    const formattedIssues = (result.issues || []).map(issue => formatIssueResponse(issue, this.config.siteUrl));

    // Format errors for easier consumption
    const formattedErrors = (result.errors || []).map(error => ({
      status: error.status,
      message: Object.values(error.elementErrors?.errors || {}).join(', ') || 'Unknown error',
      failedElementNumber: error.failedElementNumber,
    }));

    return {
      issues: formattedIssues,
      errors: formattedErrors,
    };
  }

  /**
   * Bulk transition multiple issues to new statuses in a single API call.
   * Uses the Jira Cloud Bulk Transition API.
   * Supports up to 1000 issues per request.
   *
   * Note: This is an async operation - returns a task ID for tracking progress.
   */
  async bulkTransitionIssues(params: {
    issues: Array<{
      issueIdOrKey: string;
      transitionId: string;
    }>;
  }): Promise<{
    taskId: string;
    message: string;
    issueCount: number;
  }> {
    const { issues } = params;

    console.error(`[Jira] bulkTransitionIssues called with ${issues.length} issue(s)`);

    if (issues.length === 0) {
      console.error('[Jira] bulkTransitionIssues: No issues provided, returning early');
      return { taskId: '', message: 'No issues to transition', issueCount: 0 };
    }

    if (issues.length > 1000) {
      console.error(`[Jira] bulkTransitionIssues: Exceeded 1000 issue limit (${issues.length})`);
      throw new Error('Bulk transition is limited to 1000 issues per request. Please split your request.');
    }

    // Build the request body for bulk transition API
    // Group issues by transition ID as required by the API
    const transitionGroups: Record<string, string[]> = {};
    for (const issue of issues) {
      if (!transitionGroups[issue.transitionId]) {
        transitionGroups[issue.transitionId] = [];
      }
      transitionGroups[issue.transitionId].push(issue.issueIdOrKey);
    }

    // Convert to API format: array of { selectedIssueIdsOrKeys, transitionId }
    const bulkTransitionInputs = Object.entries(transitionGroups).map(([transitionId, selectedIssueIdsOrKeys]) => ({
      selectedIssueIdsOrKeys,
      transitionId,
    }));

    console.error(`[Jira] bulkTransitionIssues: Grouped into ${bulkTransitionInputs.length} transition group(s)`);

    const result = await this.request<{
      taskId: string;
    }>('POST', '/bulk/issues/transition', {
      body: { bulkTransitionInputs },
    });

    console.error(`[Jira] bulkTransitionIssues: Task created with ID ${result.taskId}`);

    return {
      taskId: result.taskId,
      message: `Bulk transition started for ${issues.length} issue(s).`,
      issueCount: issues.length,
    };
  }

  /**
   * Bulk update labels on multiple issues in a single API call.
   * Uses the Jira Cloud Bulk Edit API.
   * Supports up to 1000 issues per request.
   *
   * Note: This is an async operation - returns a task ID for tracking progress.
   *
   * Why only labels? Jira's Bulk Edit API has significant limitations:
   * - Summary, description, assignee fields are NOT supported for bulk editing
   * - Priority and issueType require IDs and have inconsistent behavior
   * - Labels is the most reliable and commonly used bulk operation
   * See: https://community.atlassian.com/forums/Jira-questions/Bulk-Change-Description-Field/qaq-p/897762
   */
  async bulkUpdateIssues(params: {
    issueIdsOrKeys: string[];
    labels: {
      values: string[];
      action: 'ADD' | 'REMOVE' | 'SET';
    };
  }): Promise<{
    taskId: string;
    message: string;
    issueCount: number;
  }> {
    const { issueIdsOrKeys, labels } = params;

    console.error(`[Jira] bulkUpdateIssues called with ${issueIdsOrKeys.length} issue(s), action: ${labels.action}`);

    if (issueIdsOrKeys.length === 0) {
      console.error('[Jira] bulkUpdateIssues: No issues provided, returning early');
      return { taskId: '', message: 'No issues to update', issueCount: 0 };
    }

    if (issueIdsOrKeys.length > 1000) {
      console.error(`[Jira] bulkUpdateIssues: Exceeded 1000 issue limit (${issueIdsOrKeys.length})`);
      throw new Error('Bulk update is limited to 1000 issues per request. Please split your request.');
    }

    // Build the editedFieldsInput for labels
    // Only labels are supported - see JSDoc above for why other fields are excluded
    const selectedActions = ['labels'];
    const editedFieldsInput = {
      labelsFields: [
        {
          fieldId: 'labels',
          labels: labels.values.map(name => ({ name })),
          bulkEditMultiSelectFieldOption: labels.action,
        },
      ],
    };

    console.error(
      `[Jira] bulkUpdateIssues: Updating labels [${labels.values.join(', ')}] with action ${labels.action}`
    );

    const result = await this.request<{
      taskId: string;
    }>('POST', '/bulk/issues/fields', {
      body: {
        selectedActions,
        selectedIssueIdsOrKeys: issueIdsOrKeys,
        editedFieldsInput,
      },
    });

    console.error(`[Jira] bulkUpdateIssues: Task created with ID ${result.taskId}`);

    return {
      taskId: result.taskId,
      message: `Bulk label update started for ${issueIdsOrKeys.length} issue(s). Action: ${labels.action}.`,
      issueCount: issueIdsOrKeys.length,
    };
  }

  /**
   * Get watchers for an issue
   */
  async getWatchers(params: { issueKey: string }): Promise<any> {
    const { issueKey } = params;
    const result = await this.request<JiraWatchersResponse>('GET', `/issue/${issueKey}/watchers`);
    return formatWatchers(result);
  }

  /**
   * Add a watcher to an issue
   */
  async addWatcher(params: { issueKey: string; accountId: string }): Promise<void> {
    const { issueKey, accountId } = params;
    // Jira expects the account ID as a bare JSON string, not an object.
    // request() runs JSON.stringify on the body, so the raw string becomes the quoted string Jira wants.
    await this.request<void>('POST', `/issue/${issueKey}/watchers`, {
      body: accountId,
    });
  }

  /**
   * Remove a watcher from an issue
   */
  async removeWatcher(params: { issueKey: string; accountId: string }): Promise<void> {
    const { issueKey, accountId } = params;
    await this.request<void>('DELETE', `/issue/${issueKey}/watchers`, {
      query: { accountId },
    });
  }

  // --- Issue Link Operations ---

  /**
   * Get all available issue link types in the Jira instance
   */
  async getIssueLinkTypes(): Promise<FormattedJiraIssueLinkType[]> {
    const result = await this.request<JiraIssueLinkTypesResponse>('GET', '/issueLinkType');
    return formatIssueLinkTypes(result);
  }

  /**
   * Get all issue links for a specific issue
   */
  async getIssueLinks(params: { issueKey: string }): Promise<FormattedJiraIssueLink[]> {
    const { issueKey } = params;

    if (!isValidIssueKey(issueKey)) {
      throw new Error(`Invalid issue key format: ${issueKey}. Expected format: PROJECT-123`);
    }

    // Fetch issue with only issuelinks field to minimize response size
    const issue = await this.request<{ fields: { issuelinks: JiraIssueLink[] } }>('GET', `/issue/${issueKey}`, {
      query: { fields: 'issuelinks' },
    });

    return formatIssueLinks(issue.fields?.issuelinks || [], this.config.siteUrl);
  }

  /**
   * Create a link between two issues.
   * Uses intuitive sourceIssue/targetIssue terminology:
   * - sourceIssue: The issue doing the action (e.g., PROJ-1 in "PROJ-1 blocks PROJ-2")
   * - targetIssue: The issue being acted upon (e.g., PROJ-2 in "PROJ-1 blocks PROJ-2")
   *
   * This maps to Jira's API as: sourceIssue -> outwardIssue, targetIssue -> inwardIssue
   *
   * @returns void - Jira returns 201 with no body on success
   */
  async createIssueLink(params: { linkType: string; sourceIssue: string; targetIssue: string }): Promise<void> {
    const { linkType, sourceIssue, targetIssue } = params;

    if (!isValidIssueKey(sourceIssue)) {
      throw new Error(`Invalid source issue key format: ${sourceIssue}. Expected format: PROJECT-123`);
    }
    if (!isValidIssueKey(targetIssue)) {
      throw new Error(`Invalid target issue key format: ${targetIssue}. Expected format: PROJECT-123`);
    }

    // Fetch available link types to match case-insensitively
    const linkTypes = await this.getIssueLinkTypes();
    const matchedType = linkTypes.find(t => t.name?.toLowerCase() === linkType.toLowerCase());

    if (!matchedType) {
      const availableTypes = linkTypes.map(t => t.name).join(', ');
      throw new Error(`Invalid link type: "${linkType}". Available types: ${availableTypes}`);
    }

    // Map intuitive terminology to Jira's API:
    // sourceIssue (does the action) -> outwardIssue
    // targetIssue (receives the action) -> inwardIssue
    await this.request<void>('POST', '/issueLink', {
      body: {
        type: { name: matchedType.name },
        outwardIssue: { key: sourceIssue },
        inwardIssue: { key: targetIssue },
      },
    });
  }

  /**
   * Delete an issue link by its ID
   */
  async deleteIssueLink(params: { linkId: string }): Promise<void> {
    const { linkId } = params;
    await this.request<void>('DELETE', `/issueLink/${linkId}`);
  }

  /**
   * Find a specific issue link between two issues by their keys and link type.
   * Searches bidirectionally - works regardless of which issue key is provided first.
   *
   * @returns The link ID if found, null if no matching link exists
   */
  async findIssueLink(params: { issueKey: string; linkedIssueKey: string; linkType: string }): Promise<string | null> {
    const { issueKey, linkedIssueKey, linkType } = params;

    if (!isValidIssueKey(issueKey)) {
      throw new Error(`Invalid issue key format: ${issueKey}. Expected format: PROJECT-123`);
    }
    if (!isValidIssueKey(linkedIssueKey)) {
      throw new Error(`Invalid linked issue key format: ${linkedIssueKey}. Expected format: PROJECT-123`);
    }

    // Get all links for the first issue
    const links = await this.getIssueLinks({ issueKey });

    // Search for a link matching the criteria (case-insensitive type matching)
    const linkTypeLower = linkType.toLowerCase();

    for (const link of links) {
      if (link.type.name?.toLowerCase() !== linkTypeLower) {
        continue;
      }

      // Check both directions
      const outwardKey = link.outwardIssue?.key;
      const inwardKey = link.inwardIssue?.key;

      // Match if linkedIssueKey is either the outward or inward issue
      if (outwardKey === linkedIssueKey || inwardKey === linkedIssueKey) {
        return link.id ?? null;
      }
    }

    return null;
  }

  // --- Project Role & Member Operations ---

  /**
   * Get all project roles for a project.
   * Returns a list of roles with their IDs.
   */
  async getProjectRoles(params: { projectKey: string }): Promise<Array<{ name: string; id: number }>> {
    const { projectKey } = params;
    const rolesMap = await this.request<Record<string, string>>('GET', `/project/${projectKey}/role`);
    return formatProjectRoles(rolesMap);
  }

  /**
   * Get members (actors) for a specific project role.
   * Returns the role details with a simplified list of user and group members.
   */
  async getProjectRoleMembers(params: { projectKey: string; roleId: number }): Promise<{
    name: string;
    id: number;
    description: string;
    members: FormattedRoleMember[];
  }> {
    const { projectKey, roleId } = params;
    const role = await this.request<JiraProjectRole>('GET', `/project/${projectKey}/role/${roleId}`);
    return formatProjectRoleMembers(role);
  }

  /**
   * Get all project members grouped by role.
   * Convenience method that fetches all roles then all members for each role.
   * Deduplicates users who appear in multiple roles.
   */
  async getAllProjectMembers(params: { projectKey: string }): Promise<{
    projectKey: string;
    roles: Array<{
      name: string;
      id: number;
      members: FormattedRoleMember[];
    }>;
    allMembers: Array<FormattedRoleMember & { roles: string[] }>;
  }> {
    const { projectKey } = params;

    const roles = await this.getProjectRoles({ projectKey });

    const roleDetails = await Promise.all(
      roles.map(role => this.getProjectRoleMembers({ projectKey, roleId: role.id }))
    );

    const memberMap = new Map<string, FormattedRoleMember & { roles: string[] }>();

    for (const role of roleDetails) {
      for (const member of role.members) {
        const key = member.accountId || member.groupName || member.displayName;
        const existing = memberMap.get(key);
        if (existing) {
          existing.roles.push(role.name);
        } else {
          memberMap.set(key, { ...member, roles: [role.name] });
        }
      }
    }

    return {
      projectKey,
      roles: roleDetails.map(r => ({
        name: r.name,
        id: r.id,
        members: r.members,
      })),
      allMembers: Array.from(memberMap.values()),
    };
  }

  // --- Attachment Operations ---

  /**
   * List all attachments for an issue
   */
  async listAttachments(params: { issueKey: string }): Promise<JiraAttachment[]> {
    const { issueKey } = params;

    if (!isValidIssueKey(issueKey)) {
      throw new Error(`Invalid issue key format: ${issueKey}. Expected format: PROJECT-123`);
    }

    // Fetch issue with only attachment field to minimize response size
    const issue = await this.request<{ fields: { attachment: JiraAttachment[] } }>('GET', `/issue/${issueKey}`, {
      query: { fields: 'attachment' },
    });

    const attachments = issue.fields?.attachment || [];

    // Format attachments with readable info
    return attachments.map(att => ({
      id: att.id,
      self: att.self,
      filename: att.filename,
      author: att.author,
      created: att.created,
      size: att.size,
      mimeType: att.mimeType,
      content: att.content,
      thumbnail: att.thumbnail,
    }));
  }

  /**
   * Upload an attachment to an issue.
   * Jira requires multipart/form-data with X-Atlassian-Token: no-check header.
   *
   * @param params.issueKey - The issue key (e.g., PROJ-123)
   * @param params.filename - Name for the uploaded file
   * @param params.content - Base64-encoded file content
   * @param params.mimeType - MIME type (auto-detected if omitted)
   */
  async uploadAttachment(params: {
    issueKey: string;
    filename: string;
    content: string;
    mimeType?: string;
  }): Promise<JiraAttachmentUploadResponse[]> {
    const { issueKey, filename, content, mimeType } = params;

    if (!isValidIssueKey(issueKey)) {
      throw new Error(`Invalid issue key format: ${issueKey}. Expected format: PROJECT-123`);
    }

    const binaryContent = Buffer.from(content, 'base64');

    // Check file size limit
    if (binaryContent.length > JIRA_MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `File size (${Math.round(binaryContent.length / 1024 / 1024)}MB) exceeds maximum allowed size (${JIRA_MAX_ATTACHMENT_SIZE / 1024 / 1024}MB)`
      );
    }

    // Detect MIME type if not provided
    const detectedMimeType = mimeType || _detectMimeType(filename);

    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([binaryContent], { type: detectedMimeType });
    formData.append('file', blob, filename);

    const url = `${this.config.apiBaseUrl}/issue/${issueKey}/attachments`;

    // Make request with special headers for attachment upload
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.config.authHeader,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check', // Required for attachment uploads
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 413) {
        throw new Error(`File too large: The attachment exceeds Jira's maximum file size limit.`);
      }
      throw new Error(`Jira attachment upload error (${response.status}): ${errorBody}`);
    }

    const result = (await response.json()) as JiraAttachmentUploadResponse[];
    return result;
  }

  /**
   * Download an attachment by ID.
   * Returns the file content as base64-encoded string.
   */
  async downloadAttachment(params: { attachmentId: string }): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    content: string;
  }> {
    const { attachmentId } = params;

    // First, get attachment metadata to get the download URL
    const metadata = await this.request<JiraAttachment>('GET', `/attachment/${attachmentId}`);

    if (!metadata.content) {
      throw new Error(`Attachment ${attachmentId} has no download URL`);
    }

    // Download the actual file content
    const response = await fetch(metadata.content, {
      method: 'GET',
      headers: {
        Authorization: this.config.authHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download attachment (${response.status}): ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const content = Buffer.from(arrayBuffer).toString('base64');

    return {
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      size: metadata.size,
      content,
    };
  }

  /**
   * Delete an attachment by ID.
   */
  async deleteAttachment(params: { attachmentId: string }): Promise<void> {
    const { attachmentId } = params;
    await this.request<void>('DELETE', `/attachment/${attachmentId}`);
  }

  // --- Agile API Access (Jira Software - Boards, Sprints) ---

  private _agileApi: AgileApi | null = null;

  /**
   * Get the Agile API client for board and sprint operations.
   * Lazily instantiated on first access.
   */
  get agile(): AgileApi {
    if (!this._agileApi) {
      this._agileApi = new AgileApi(this.config);
    }
    return this._agileApi;
  }
}
