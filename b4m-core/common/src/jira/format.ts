/**
 * Format Jira API responses to only include relevant fields for AI consumption.
 * This reduces token usage and prevents exposing unnecessary internal details.
 */

import type { FormattedJiraIssue } from './api';

/**
 * Strips HTML tags and normalizes whitespace from text content.
 *
 * @param html - HTML string to clean
 * @returns Plain text with normalized whitespace
 */
function stripHtmlAndNormalizeWhitespace(html: string | undefined): string {
  if (!html) return '';

  return (
    html
      // Remove HTML tags
      .replace(/<[^>]*>/g, '')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Normalize whitespace: collapse multiple spaces/newlines to single space
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ============================================================================
// Raw Jira API response shapes (only the fields these formatters read) + the
// Formatted* shapes they return. On a malformed/error payload the formatters
// throw (the request layer already throws on non-2xx, and jira/api.ts callers
// surface errors via try/catch) - so the Formatted* return types are precise
// and non-nullable, with no consumer-side narrowing.
// ============================================================================

/** Minimal recursive Atlassian Document Format node (description/comment bodies). */
interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

interface JiraErrorEnvelope {
  error?: unknown;
  errors?: unknown;
}

interface RawJiraUserRef {
  accountId?: string;
  displayName?: string;
  accountType?: string;
}

interface RawJiraIssueRef extends JiraErrorEnvelope {
  id?: string;
  key?: string;
}

interface RawJiraIssueType {
  id?: string;
  name?: string;
  description?: string;
  subtask?: boolean;
}

interface RawJiraProject extends JiraErrorEnvelope {
  id?: string;
  key?: string;
  name?: string;
  description?: string;
  projectTypeKey?: string;
  style?: string;
  lead?: { accountId?: string; displayName?: string };
  issueTypes?: RawJiraIssueType[];
}

interface RawJiraIssueFields {
  summary?: string;
  description?: AdfNode | string;
  status?: { name?: string };
  issuetype?: { name?: string };
  priority?: { name?: string };
  assignee?: RawJiraUserRef | null;
  reporter?: RawJiraUserRef | null;
  created?: string;
  updated?: string;
  project?: { key?: string; name?: string };
  subtasks?: Array<{ id?: string; key?: string }>;
  labels?: string[];
}

interface RawJiraIssue extends JiraErrorEnvelope {
  id?: string;
  key?: string;
  fields?: RawJiraIssueFields;
}

interface RawJiraSearchResult extends JiraErrorEnvelope {
  total?: number;
  startAt?: number;
  maxResults?: number;
  issues?: RawJiraIssue[];
  nextPageToken?: string;
}

interface RawJiraProjectListResponse extends JiraErrorEnvelope {
  values?: RawJiraProject[];
}

interface RawJiraComment extends JiraErrorEnvelope {
  id?: string;
  body?: AdfNode | string;
  author?: { accountId?: string; displayName?: string };
  created?: string;
  updated?: string;
}

interface RawJiraTransition {
  id?: string;
  name?: string;
  to?: { id?: string; name?: string };
}

interface RawJiraTransitionsResponse extends JiraErrorEnvelope {
  transitions?: RawJiraTransition[];
}

interface RawJiraWatcher {
  accountId?: string;
  displayName?: string;
  active?: boolean;
}

interface RawJiraWatchersResponse extends JiraErrorEnvelope {
  isWatching?: boolean;
  watchCount?: number;
  watchers?: RawJiraWatcher[];
}

interface RawJiraLinkType {
  id?: string;
  name?: string;
  inward?: string;
  outward?: string;
}

interface RawJiraIssueLinkTypesResponse extends JiraErrorEnvelope {
  issueLinkTypes?: RawJiraLinkType[];
}

interface RawJiraLinkedIssue {
  key?: string;
  fields?: { summary?: string; status?: { name?: string } };
}

interface RawJiraIssueLink {
  id?: string;
  type?: { name?: string; inward?: string; outward?: string };
  outwardIssue?: RawJiraLinkedIssue;
  inwardIssue?: RawJiraLinkedIssue;
}

export interface FormattedJiraIssueRef {
  id: string;
  key: string;
  link: string;
}

export interface FormattedJiraIssueType {
  id?: string;
  name?: string;
  description: string;
  subtask?: boolean;
}

export interface FormattedJiraProject {
  id: string;
  key: string;
  name?: string;
  description: string;
  link: string;
  projectTypeKey?: string;
  lead?: { accountId?: string; displayName?: string };
  issueTypes?: FormattedJiraIssueType[];
}

export interface FormattedJiraSearchResults {
  total: number;
  startAt: number;
  maxResults: number;
  issues: FormattedJiraIssue[];
  nextPageToken?: string;
}

export interface FormattedJiraProjectListItem {
  id?: string;
  key?: string;
  name?: string;
  projectTypeKey?: string;
  style?: string;
  link: string;
}

export interface FormattedJiraComment {
  id: string;
  body: string;
  author: { accountId?: string; displayName?: string } | null;
  created?: string;
  updated?: string;
}

export interface FormattedJiraTransition {
  id?: string;
  name?: string;
  to?: { id?: string; name?: string };
}

export interface FormattedJiraTransitions {
  transitions: FormattedJiraTransition[];
}

export interface FormattedJiraWatchers {
  isWatching?: boolean;
  watchCount?: number;
  watchers: Array<{ accountId?: string; displayName?: string; active?: boolean }>;
}

export interface FormattedJiraIssueLinkType {
  id?: string;
  name?: string;
  inward?: string;
  outward?: string;
}

export interface FormattedJiraIssueLinkSide {
  key?: string;
  summary?: string;
  status?: string;
  link: string;
}

export interface FormattedJiraIssueLink {
  id?: string;
  type: { name?: string; inward?: string; outward?: string };
  outwardIssue?: FormattedJiraIssueLinkSide;
  inwardIssue?: FormattedJiraIssueLinkSide;
}

/**
 * Builds the error thrown when a Jira API response is malformed or carries an error
 * envelope. The request layer already throws on non-2xx, so this only guards the rare
 * 2xx-with-bad-body case; jira/api.ts callers surface it through their try/catch.
 */
function jiraResponseError(kind: string, payload: unknown): Error {
  let detail = 'unexpected response shape';
  if (payload && typeof payload === 'object') {
    const env = payload as JiraErrorEnvelope;
    if (env.error || env.errors) {
      const raw = env.error ?? env.errors;
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
  }
  return new Error(`Jira ${kind} response was malformed: ${detail}`);
}

/** Extracts plain text from an Atlassian Document Format (ADF) body. */
function extractTextFromADF(adf: AdfNode | string | undefined): string {
  // Some Jira endpoints/contexts return a plain-string body instead of ADF.
  if (typeof adf === 'string') return adf;
  if (!adf || typeof adf !== 'object') return '';
  if (adf.type === 'text') return adf.text || '';
  if (Array.isArray(adf.content)) {
    return adf.content.map(extractTextFromADF).join('\n').trim();
  }
  return '';
}

/**
 * Formats a Jira issue response to include a clickable link.
 * Keeps only id, key, and adds a web link to the issue.
 *
 * @param issue - Raw issue object from Jira API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted issue object with id, key, and link
 * @throws if the response is an error envelope or lacks id/key
 */
export function formatIssueResponse(issue: RawJiraIssueRef, siteUrl: string): FormattedJiraIssueRef {
  if (!issue || typeof issue !== 'object' || issue.error || issue.errors || !issue.id || !issue.key) {
    throw jiraResponseError('issue', issue);
  }

  // Strip /wiki or /jira suffix from siteUrl to get base domain
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const link = `${baseUrl}/browse/${issue.key}`;

  return {
    id: issue.id,
    key: issue.key,
    link,
  };
}

/**
 * Formats a Jira project response to include only essential fields for AI.
 * Removes verbose fields like avatar URLs, API endpoints, UUIDs, etc.
 *
 * @param project - Raw project object from Jira API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted project object with essential fields only
 */
export function formatProjectResponse(project: RawJiraProject, siteUrl: string): FormattedJiraProject {
  if (!project || typeof project !== 'object' || project.error || project.errors || !project.id || !project.key) {
    throw jiraResponseError('project', project);
  }

  // Strip /wiki or /jira suffix from siteUrl to get base domain
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const link = `${baseUrl}/browse/${project.key}`;

  // Format issue types to only include essential info
  const issueTypes = Array.isArray(project.issueTypes)
    ? project.issueTypes.map(type => ({
        id: type.id,
        name: type.name,
        description: stripHtmlAndNormalizeWhitespace(type.description),
        subtask: type.subtask,
      }))
    : undefined;

  // Format lead to only include essential info
  const lead = project.lead
    ? {
        accountId: project.lead.accountId,
        displayName: project.lead.displayName,
      }
    : undefined;

  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: stripHtmlAndNormalizeWhitespace(project.description || ''),
    link,
    projectTypeKey: project.projectTypeKey,
    lead,
    issueTypes,
  };
}

/**
 * Formats a Jira issue details response to include only essential fields for AI.
 * Removes verbose metadata, avatars, expand fields, and internal system data.
 *
 * @param issue - Raw issue object from Jira API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted issue object with essential fields only
 */
export function formatIssueDetails(issue: RawJiraIssue, siteUrl: string): FormattedJiraIssue {
  if (!issue || typeof issue !== 'object' || issue.error || issue.errors || !issue.id || !issue.key) {
    throw jiraResponseError('issue', issue);
  }

  // Strip /wiki or /jira suffix from siteUrl to get base domain
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const link = `${baseUrl}/browse/${issue.key}`;

  const description = issue.fields?.description ? extractTextFromADF(issue.fields.description) : '';

  // Format subtasks to only include essential info
  const subtasks = Array.isArray(issue.fields?.subtasks)
    ? issue.fields.subtasks.map(subtask => ({
        id: subtask.id ?? '',
        key: subtask.key ?? '',
        link: `${baseUrl}/browse/${subtask.key ?? ''}`,
      }))
    : undefined;

  return {
    id: issue.id,
    key: issue.key,
    link,
    summary: issue.fields?.summary || '',
    description: stripHtmlAndNormalizeWhitespace(description),
    status: issue.fields?.status?.name || '',
    issueType: issue.fields?.issuetype?.name || '',
    priority: issue.fields?.priority?.name,
    assignee: issue.fields?.assignee
      ? {
          accountId: issue.fields.assignee.accountId ?? '',
          displayName: issue.fields.assignee.displayName ?? '',
          accountType: issue.fields.assignee.accountType,
        }
      : null,
    reporter: issue.fields?.reporter
      ? {
          accountId: issue.fields.reporter.accountId ?? '',
          displayName: issue.fields.reporter.displayName ?? '',
        }
      : null,
    created: issue.fields?.created,
    updated: issue.fields?.updated,
    project: issue.fields?.project
      ? {
          key: issue.fields.project.key ?? '',
          name: issue.fields.project.name ?? '',
        }
      : undefined,
    subtasks,
    labels: Array.isArray(issue.fields?.labels) ? issue.fields.labels : [],
  };
}

/**
 * Formats Jira search results to include only essential fields for AI.
 * Removes verbose metadata, schema definitions, and expand fields.
 *
 * @param searchResult - Raw search result from Jira API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted search result with essential fields only
 */
export function formatSearchResults(searchResult: RawJiraSearchResult, siteUrl: string): FormattedJiraSearchResults {
  if (!searchResult || typeof searchResult !== 'object' || searchResult.error || searchResult.errors) {
    throw jiraResponseError('search', searchResult);
  }

  const issues = Array.isArray(searchResult.issues)
    ? searchResult.issues.map(issue => formatIssueDetails(issue, siteUrl))
    : [];

  return {
    total: searchResult.total || 0,
    startAt: searchResult.startAt || 0,
    maxResults: searchResult.maxResults || 0,
    issues,
    ...(searchResult.nextPageToken && { nextPageToken: searchResult.nextPageToken }),
  };
}

/**
 * Formats a list of Jira projects to include only essential fields for AI.
 * Removes verbose fields like avatar URLs, API endpoints, UUIDs, etc.
 * Project list API returns limited info compared to individual project details.
 *
 * @param response - Raw project list response from Jira API (contains values array)
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted project array with essential fields only
 */
export function formatProjectList(
  response: RawJiraProjectListResponse | RawJiraProject[],
  siteUrl: string
): FormattedJiraProjectListItem[] {
  if (!response || typeof response !== 'object') {
    throw jiraResponseError('project list', response);
  }
  // Only the wrapped response object carries an error envelope; a bare array does not.
  if (!Array.isArray(response) && (response.error || response.errors)) {
    throw jiraResponseError('project list', response);
  }

  const projects: RawJiraProject[] = Array.isArray(response)
    ? response
    : Array.isArray(response.values)
      ? response.values
      : [];
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');

  return projects.map(project => ({
    id: project.id,
    key: project.key,
    name: project.name,
    projectTypeKey: project.projectTypeKey,
    style: project.style,
    link: `${baseUrl}/browse/${project.key}`,
  }));
}

/**
 * Formats a Jira comment response to include only essential fields for AI.
 * Removes verbose metadata, avatars, rendered body, and internal fields.
 *
 * @param comment - Raw comment object from Jira API
 * @returns Formatted comment object with essential fields only
 */
export function formatComment(comment: RawJiraComment): FormattedJiraComment {
  if (!comment || typeof comment !== 'object' || comment.error || comment.errors || !comment.id) {
    throw jiraResponseError('comment', comment);
  }

  const bodyText = comment.body ? extractTextFromADF(comment.body) : '';

  return {
    id: comment.id,
    body: stripHtmlAndNormalizeWhitespace(bodyText),
    author: comment.author
      ? {
          accountId: comment.author.accountId,
          displayName: comment.author.displayName,
        }
      : null,
    created: comment.created,
    updated: comment.updated,
  };
}

/**
 * Formats Jira transitions response to include only essential fields for AI.
 * Removes verbose metadata, screen info, and internal workflow fields.
 *
 * @param transitionsResponse - Raw transitions response from Jira API
 * @returns Formatted transitions response with essential fields only
 */
export function formatTransitions(transitionsResponse: RawJiraTransitionsResponse): FormattedJiraTransitions {
  if (
    !transitionsResponse ||
    typeof transitionsResponse !== 'object' ||
    transitionsResponse.error ||
    transitionsResponse.errors
  ) {
    throw jiraResponseError('transitions', transitionsResponse);
  }

  const transitions = Array.isArray(transitionsResponse.transitions)
    ? transitionsResponse.transitions.map(transition => ({
        id: transition.id,
        name: transition.name,
        to: transition.to,
      }))
    : [];

  return { transitions };
}

export interface FormattedJiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
}

/**
 * Formats a Jira user response to include only essential fields for AI.
 * Removes verbose metadata, avatars, groups, application roles, and expand fields.
 *
 * @param user - Raw user object from Jira API
 * @returns Formatted user object with essential fields only
 */
export function formatUser(user: {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
  error?: unknown;
  errors?: unknown;
}): FormattedJiraUser {
  // If the response is an error or doesn't have expected structure, return as-is
  if (!user || typeof user !== 'object' || user.error || user.errors) {
    return user as FormattedJiraUser;
  }

  return {
    accountId: user.accountId ?? '',
    displayName: user.displayName ?? '',
    emailAddress: user.emailAddress,
    active: user.active ?? false,
  };
}

/**
 * Formats a Jira issue transition result to include a clickable link.
 * Used after successfully transitioning an issue to provide quick access.
 *
 * @param result - Transition result with issueKey and transitionId
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted result with issue link added
 */
export function formatTransitionResult(
  result: { issueKey: string; transitionId: string },
  siteUrl: string
): { issueKey: string; transitionId: string; link: string } {
  // Strip /wiki or /jira suffix from siteUrl to get base domain
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const link = `${baseUrl}/browse/${result.issueKey}`;

  return {
    issueKey: result.issueKey,
    transitionId: result.transitionId,
    link,
  };
}

/**
 * Formats a list of Jira users to include only essential fields for AI.
 * Removes verbose metadata, avatars, groups, application roles, and expand fields.
 *
 * @param users - Array of raw user objects from Jira API
 * @returns Formatted user array with essential fields only
 */
export function formatUserList(users: Parameters<typeof formatUser>[0][]): FormattedJiraUser[] {
  if (!Array.isArray(users)) {
    return [];
  }

  return users.map(user => formatUser(user));
}

/**
 * Formats Jira watchers response to include only essential fields for AI.
 * Removes verbose metadata and avatars.
 *
 * @param watchersResponse - Raw watchers response from Jira API
 * @returns Formatted watchers object with essential fields only
 */
export function formatWatchers(watchersResponse: RawJiraWatchersResponse): FormattedJiraWatchers {
  if (!watchersResponse || typeof watchersResponse !== 'object' || watchersResponse.error || watchersResponse.errors) {
    throw jiraResponseError('watchers', watchersResponse);
  }

  const watchers = Array.isArray(watchersResponse.watchers)
    ? watchersResponse.watchers.map(watcher => ({
        accountId: watcher.accountId,
        displayName: watcher.displayName,
        active: watcher.active,
      }))
    : [];

  return {
    isWatching: watchersResponse.isWatching,
    watchCount: watchersResponse.watchCount,
    watchers,
  };
}

/**
 * Formats Jira issue link types response to include only essential fields for AI.
 * Removes verbose metadata and self URLs.
 *
 * @param response - Raw issue link types response from Jira API
 * @returns Formatted array of link types with essential fields only
 */
export function formatIssueLinkTypes(response: RawJiraIssueLinkTypesResponse): FormattedJiraIssueLinkType[] {
  // If the response is an error or doesn't have expected structure, return empty array
  if (!response || typeof response !== 'object' || response.error || response.errors) {
    return [];
  }

  const linkTypes = Array.isArray(response.issueLinkTypes) ? response.issueLinkTypes : [];

  return linkTypes.map(type => ({
    id: type.id,
    name: type.name,
    inward: type.inward,
    outward: type.outward,
  }));
}

/**
 * Formats Jira issue links to include only essential fields for AI.
 * Groups links by type and includes clickable URLs for linked issues.
 *
 * @param links - Array of raw issue link objects from Jira API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted array of issue links with essential fields only
 */
export function formatIssueLinks(links: RawJiraIssueLink[], siteUrl: string): FormattedJiraIssueLink[] {
  if (!Array.isArray(links)) {
    return [];
  }

  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');

  return links.map(link => {
    const formatted: FormattedJiraIssueLink = {
      id: link.id,
      type: {
        name: link.type?.name,
        inward: link.type?.inward,
        outward: link.type?.outward,
      },
    };

    // Format outward issue if present
    if (link.outwardIssue) {
      formatted.outwardIssue = {
        key: link.outwardIssue.key,
        summary: link.outwardIssue.fields?.summary,
        status: link.outwardIssue.fields?.status?.name,
        link: `${baseUrl}/browse/${link.outwardIssue.key}`,
      };
    }

    // Format inward issue if present
    if (link.inwardIssue) {
      formatted.inwardIssue = {
        key: link.inwardIssue.key,
        summary: link.inwardIssue.fields?.summary,
        status: link.inwardIssue.fields?.status?.name,
        link: `${baseUrl}/browse/${link.inwardIssue.key}`,
      };
    }

    return formatted;
  });
}

// ============================================================================
// Project Role Formatters
// ============================================================================

export interface FormattedRoleMember {
  type: 'user' | 'group';
  displayName: string;
  accountId?: string;
  groupName?: string;
}

/**
 * Formats the project roles map into an LLM-friendly array.
 * Extracts the numeric role ID from each URL.
 *
 * @param rolesMap - Raw roles map from Jira API (role name -> URL)
 * @returns Array of { name, id } objects
 */
export function formatProjectRoles(rolesMap: Record<string, string>): Array<{ name: string; id: number }> {
  if (!rolesMap || typeof rolesMap !== 'object') return [];

  return Object.entries(rolesMap).map(([name, url]) => {
    const idMatch = url.match(/\/role\/(\d+)$/);
    const id = idMatch ? parseInt(idMatch[1], 10) : 0;
    return { name, id };
  });
}

/**
 * Formats a project role response to extract only essential member info.
 * Strips verbose metadata, self URLs, and internal actor types.
 *
 * @param role - Raw project role response from Jira API
 * @returns Formatted role with essential fields and simplified actors
 */
export function formatProjectRoleMembers(role: {
  name?: string;
  id?: number;
  description?: string;
  actors?: Array<{
    displayName?: string;
    type?: string;
    actorUser?: { accountId?: string };
    actorGroup?: { name?: string; displayName?: string };
  }>;
  error?: unknown;
  errors?: unknown;
}): {
  name: string;
  id: number;
  description: string;
  members: FormattedRoleMember[];
} {
  if (!role || typeof role !== 'object' || role.error || role.errors) {
    return role as ReturnType<typeof formatProjectRoleMembers>;
  }

  const members: FormattedRoleMember[] = (role.actors || []).map(actor => {
    if (actor.actorUser) {
      return {
        type: 'user' as const,
        displayName: actor.displayName || '',
        accountId: actor.actorUser.accountId || '',
      };
    }
    return {
      type: 'group' as const,
      displayName: actor.actorGroup?.displayName || actor.displayName || '',
      groupName: actor.actorGroup?.name || '',
    };
  });

  return {
    name: role.name || '',
    id: role.id || 0,
    description: role.description || '',
    members,
  };
}

// Re-export Agile formatters for backward compatibility
export { formatBoard, formatBoardList, formatSprint, formatSprintList, formatSprintIssues } from './agile/format';
