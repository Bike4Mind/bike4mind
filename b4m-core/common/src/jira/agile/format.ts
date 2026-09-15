/**
 * Format Jira Agile API responses to only include relevant fields for AI consumption.
 * This reduces token usage and prevents exposing unnecessary internal details.
 */

import { formatIssueDetails } from '../format';
import type {
  JiraBoard,
  JiraBoardListResponse,
  JiraBoardConfiguration,
  JiraBoardIssuesResponse,
  JiraSprint,
  JiraSprintListResponse,
  JiraSprintIssuesResponse,
  FormattedBoard,
  FormattedBoardList,
  FormattedBoardConfiguration,
  FormattedBoardIssues,
  FormattedSprint,
  FormattedSprintList,
  FormattedSprintIssues,
  FormattedIssueDetails,
  BoardIssueGroupBy,
} from './types';

/**
 * Formats a Jira board response to include only essential fields for AI.
 * Removes verbose metadata, self URLs, and internal system data.
 *
 * @param board - Raw board object from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted board object with essential fields only
 */
export function formatBoard(board: JiraBoard, siteUrl: string): FormattedBoard {
  // Defensive check for invalid/error responses
  if (!board || typeof board !== 'object' || 'error' in board || 'errors' in board || !board.id) {
    console.warn('[formatBoard] Received invalid or error response:', JSON.stringify(board));
    throw new Error(`Invalid board data received: ${JSON.stringify(board)}`);
  }

  // Build board URL (Jira Software boards are at /jira/software/projects/{key}/boards/{id})
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const projectKey = board.location?.projectKey;
  const link = projectKey
    ? `${baseUrl}/jira/software/projects/${projectKey}/boards/${board.id}`
    : `${baseUrl}/jira/software/c/projects?selectedProjectType=software`; // Fallback to board list

  return {
    id: board.id,
    name: board.name,
    type: board.type,
    link,
    project: board.location
      ? {
          key: board.location.projectKey ?? '',
          name: board.location.projectName ?? '',
        }
      : undefined,
  };
}

/**
 * Formats a list of Jira boards to include only essential fields for AI.
 *
 * @param response - Raw board list response from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted board list with pagination info
 */
export function formatBoardList(response: JiraBoardListResponse, siteUrl: string): FormattedBoardList {
  // Defensive check for invalid/error responses
  if (!response || typeof response !== 'object' || 'error' in response || 'errors' in response) {
    console.warn('[formatBoardList] Received invalid or error response:', JSON.stringify(response));
    throw new Error(`Invalid board list response received: ${JSON.stringify(response)}`);
  }

  const boards = Array.isArray(response.values) ? response.values.map(board => formatBoard(board, siteUrl)) : [];

  return {
    total: response.total,
    startAt: response.startAt || 0,
    maxResults: response.maxResults || 0,
    isLast: response.isLast,
    boards,
  };
}

/**
 * Formats a Jira sprint response to include only essential fields for AI.
 * Removes verbose metadata, self URLs, and internal system data.
 *
 * @param sprint - Raw sprint object from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @param boardId - Optional board ID for building the sprint URL
 * @returns Formatted sprint object with essential fields only
 */
export function formatSprint(sprint: JiraSprint, siteUrl: string, boardId?: number): FormattedSprint {
  // Defensive check for invalid/error responses
  if (!sprint || typeof sprint !== 'object' || 'error' in sprint || 'errors' in sprint || !sprint.id) {
    console.warn('[formatSprint] Received invalid or error response:', JSON.stringify(sprint));
    throw new Error(`Invalid sprint data received: ${JSON.stringify(sprint)}`);
  }

  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  // Sprint backlog URL format (requires board ID)
  const effectiveBoardId = boardId || sprint.originBoardId;
  const link = effectiveBoardId
    ? `${baseUrl}/jira/software/c/projects?selectedProjectType=software&rapidView=${effectiveBoardId}`
    : undefined;

  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    goal: sprint.goal || undefined,
    startDate: sprint.startDate || undefined,
    endDate: sprint.endDate || undefined,
    completeDate: sprint.completeDate || undefined,
    originBoardId: sprint.originBoardId,
    link,
  };
}

/**
 * Formats a list of Jira sprints to include only essential fields for AI.
 *
 * @param response - Raw sprint list response from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @param boardId - Board ID for building sprint URLs
 * @returns Formatted sprint list with pagination info
 */
export function formatSprintList(
  response: JiraSprintListResponse,
  siteUrl: string,
  boardId: number
): FormattedSprintList {
  // Defensive check for invalid/error responses
  if (!response || typeof response !== 'object' || 'error' in response || 'errors' in response) {
    console.warn('[formatSprintList] Received invalid or error response:', JSON.stringify(response));
    throw new Error(`Invalid sprint list response received: ${JSON.stringify(response)}`);
  }

  const sprints = Array.isArray(response.values)
    ? response.values.map(sprint => formatSprint(sprint, siteUrl, boardId))
    : [];

  return {
    startAt: response.startAt || 0,
    maxResults: response.maxResults || 0,
    isLast: response.isLast,
    sprints,
  };
}

/**
 * Formats sprint issues response to include only essential fields for AI.
 *
 * @param response - Raw sprint issues response from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted sprint issues with pagination info
 */
export function formatSprintIssues(response: JiraSprintIssuesResponse, siteUrl: string): FormattedSprintIssues {
  // Defensive check for invalid/error responses
  if (!response || typeof response !== 'object' || 'error' in response || 'errors' in response) {
    console.warn('[formatSprintIssues] Received invalid or error response:', JSON.stringify(response));
    throw new Error(`Invalid sprint issues response received: ${JSON.stringify(response)}`);
  }

  const issues = Array.isArray(response.issues)
    ? response.issues.map(issue => formatIssueDetails(issue, siteUrl) as FormattedIssueDetails)
    : [];

  return {
    total: response.total || 0,
    startAt: response.startAt || 0,
    maxResults: response.maxResults || 0,
    issues,
  };
}

/**
 * Formats a Jira board configuration response to include only essential fields for AI.
 * Extracts column structure, WIP limits, and filter information.
 *
 * @param config - Raw board configuration from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted board configuration with essential fields only
 */
export function formatBoardConfiguration(config: JiraBoardConfiguration, siteUrl: string): FormattedBoardConfiguration {
  // Defensive check for invalid/error responses
  if (!config || typeof config !== 'object' || 'error' in config || 'errors' in config || !config.id) {
    console.warn('[formatBoardConfiguration] Received invalid or error response:', JSON.stringify(config));
    throw new Error(`Invalid board configuration data received: ${JSON.stringify(config)}`);
  }

  // Build board URL
  const baseUrl = siteUrl.replace(/\/(wiki|jira)\/?$/, '');
  const link = `${baseUrl}/jira/software/c/projects?rapidView=${config.id}`;

  // Format columns with WIP limits
  const columns =
    config.columnConfig?.columns?.map(col => ({
      name: col.name,
      statusIds: col.statuses?.map(s => s.id) || [],
      min: col.min,
      max: col.max,
    })) || [];

  return {
    id: config.id,
    name: config.name,
    type: config.type,
    link,
    filter: config.filter
      ? {
          id: config.filter.id,
          name: config.filter.name,
        }
      : undefined,
    jqlFilter: config.subQuery?.query,
    columns,
    constraintType: config.columnConfig?.constraintType,
    estimation: config.estimation
      ? {
          type: config.estimation.type,
          fieldName: config.estimation.field?.displayName,
        }
      : undefined,
    rankingFieldId: config.ranking?.rankCustomFieldId,
  };
}

/**
 * Formats board issues response with optional grouping by status, assignee, or epic.
 *
 * @param response - Raw board issues response from Jira Agile API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @param groupBy - Optional grouping dimension
 * @returns Formatted board issues with optional grouping
 */
export function formatBoardIssues(
  response: JiraBoardIssuesResponse,
  siteUrl: string,
  groupBy?: BoardIssueGroupBy
): FormattedBoardIssues {
  // Defensive check for invalid/error responses
  if (!response || typeof response !== 'object' || 'error' in response || 'errors' in response) {
    console.warn('[formatBoardIssues] Received invalid or error response:', JSON.stringify(response));
    throw new Error(`Invalid board issues response received: ${JSON.stringify(response)}`);
  }

  const issues = Array.isArray(response.issues)
    ? response.issues.map(issue => formatIssueDetails(issue, siteUrl) as FormattedIssueDetails)
    : [];

  const result: FormattedBoardIssues = {
    total: response.total || 0,
    startAt: response.startAt || 0,
    maxResults: response.maxResults || 0,
    issues,
  };

  // Apply grouping if requested
  if (groupBy && issues.length > 0) {
    result.groupedBy = groupBy;
    result.groups = groupIssues(issues, groupBy);
  }

  return result;
}

/**
 * Groups issues by the specified dimension.
 */
function groupIssues(
  issues: FormattedIssueDetails[],
  groupBy: BoardIssueGroupBy
): Array<{ key: string; name: string; issues: FormattedIssueDetails[] }> {
  const groups = new Map<string, { name: string; issues: FormattedIssueDetails[] }>();

  for (const issue of issues) {
    let key: string;
    let name: string;

    switch (groupBy) {
      case 'status':
        key = issue.status || 'Unknown';
        name = issue.status || 'Unknown';
        break;
      case 'assignee':
        key = issue.assignee?.accountId || 'unassigned';
        name = issue.assignee?.displayName || 'Unassigned';
        break;
      case 'epic':
        // Epic info would be in a custom field - for now use project as fallback
        key = issue.project?.key || 'no-epic';
        name = issue.project?.name || 'No Epic';
        break;
      default:
        key = 'all';
        name = 'All Issues';
    }

    if (!groups.has(key)) {
      groups.set(key, { name, issues: [] });
    }
    groups.get(key)!.issues.push(issue);
  }

  return Array.from(groups.entries()).map(([key, value]) => ({
    key,
    name: value.name,
    issues: value.issues,
  }));
}
