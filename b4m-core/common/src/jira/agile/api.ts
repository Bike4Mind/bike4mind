// Jira Agile API client for OAuth-authenticated operations
// Uses Jira Agile REST API 1.0 (Jira Software)

import { isValidIssueKey, type JiraConfig } from '../api';
import {
  formatBoard,
  formatBoardList,
  formatSprint,
  formatSprintList,
  formatSprintIssues,
  formatBoardConfiguration,
  formatBoardIssues,
} from './format';
import type {
  JiraBoardType,
  JiraSprintState,
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
  BoardIssueGroupBy,
} from './types';

type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Validates that a board or sprint ID is a positive integer.
 * Jira IDs are always positive integers.
 */
function isValidBoardOrSprintId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

export class AgileApi {
  constructor(private readonly config: JiraConfig) {}

  /**
   * Build URL for Agile API (uses different base URL than standard Jira API)
   */
  private buildAgileUrl(path: string, query: QueryParams = {}): string {
    const base = `${this.config.agileApiBaseUrl}${path}`;
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === '') return;
      url.searchParams.append(key, String(value));
    });
    return url.toString();
  }

  /**
   * Make authenticated HTTP request to Agile API
   */
  private async requestAgile<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {}
  ): Promise<T> {
    const url = this.buildAgileUrl(path, options.query);
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

    if (!response.ok) {
      const errorBody = await response.text();
      // Check for Jira Software license errors
      if (response.status === 403 && errorBody.includes('Jira Software')) {
        throw new Error(
          `Jira Software is not available: ${errorBody}. Sprint and board operations require a Jira Software license.`
        );
      }
      throw new Error(`Jira Agile API error (${response.status}): ${errorBody}`);
    }

    // 204 No Content responses don't have a body
    if (response.status === 204) {
      return undefined as T;
    }

    const data = await response.json();
    return data as T;
  }

  /**
   * List all boards visible to the user
   */
  async listBoards(params?: {
    startAt?: number;
    maxResults?: number;
    type?: JiraBoardType;
    name?: string;
    projectKeyOrId?: string;
  }): Promise<FormattedBoardList> {
    const { startAt = 0, maxResults = 50, type, name, projectKeyOrId } = params || {};

    const result = await this.requestAgile<JiraBoardListResponse>('GET', '/board', {
      query: {
        startAt,
        maxResults,
        type,
        name,
        projectKeyOrId,
      },
    });

    return formatBoardList(result, this.config.siteUrl);
  }

  /**
   * Get a single board by ID
   */
  async getBoard(params: { boardId: number }): Promise<FormattedBoard> {
    const { boardId } = params;
    if (!isValidBoardOrSprintId(boardId)) {
      throw new Error(`Invalid boardId: ${boardId}. Must be a positive integer.`);
    }
    const board = await this.requestAgile<JiraBoard>('GET', `/board/${boardId}`);
    return formatBoard(board, this.config.siteUrl);
  }

  /**
   * Get board configuration including columns, WIP limits, and filter info
   */
  async getBoardConfiguration(params: { boardId: number }): Promise<FormattedBoardConfiguration> {
    const { boardId } = params;
    if (!isValidBoardOrSprintId(boardId)) {
      throw new Error(`Invalid boardId: ${boardId}. Must be a positive integer.`);
    }
    const config = await this.requestAgile<JiraBoardConfiguration>('GET', `/board/${boardId}/configuration`);
    return formatBoardConfiguration(config, this.config.siteUrl);
  }

  /**
   * Get issues on a board with optional filtering and grouping
   */
  async getBoardIssues(params: {
    boardId: number;
    startAt?: number;
    maxResults?: number;
    jql?: string;
    fields?: string[];
    groupBy?: BoardIssueGroupBy;
  }): Promise<FormattedBoardIssues> {
    const { boardId, startAt = 0, maxResults = 50, jql, fields, groupBy } = params;
    if (!isValidBoardOrSprintId(boardId)) {
      throw new Error(`Invalid boardId: ${boardId}. Must be a positive integer.`);
    }

    const response = await this.requestAgile<JiraBoardIssuesResponse>('GET', `/board/${boardId}/issue`, {
      query: {
        startAt,
        maxResults,
        jql,
        fields: fields?.join(','),
      },
    });

    return formatBoardIssues(response, this.config.siteUrl, groupBy);
  }

  /**
   * List sprints for a board
   */
  async listSprints(params: {
    boardId: number;
    startAt?: number;
    maxResults?: number;
    state?: JiraSprintState | 'future,active' | 'active,closed';
  }): Promise<FormattedSprintList> {
    const { boardId, startAt = 0, maxResults = 50, state } = params;
    if (!isValidBoardOrSprintId(boardId)) {
      throw new Error(`Invalid boardId: ${boardId}. Must be a positive integer.`);
    }

    const result = await this.requestAgile<JiraSprintListResponse>('GET', `/board/${boardId}/sprint`, {
      query: {
        startAt,
        maxResults,
        state,
      },
    });

    return formatSprintList(result, this.config.siteUrl, boardId);
  }

  /**
   * Get a single sprint by ID
   */
  async getSprint(params: { sprintId: number }): Promise<FormattedSprint> {
    const { sprintId } = params;
    if (!isValidBoardOrSprintId(sprintId)) {
      throw new Error(`Invalid sprintId: ${sprintId}. Must be a positive integer.`);
    }
    const sprint = await this.requestAgile<JiraSprint>('GET', `/sprint/${sprintId}`);
    return formatSprint(sprint, this.config.siteUrl);
  }

  /**
   * Create a new sprint
   */
  async createSprint(params: {
    name: string;
    originBoardId: number;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<FormattedSprint> {
    const { name, originBoardId, goal, startDate, endDate } = params;
    if (!isValidBoardOrSprintId(originBoardId)) {
      throw new Error(`Invalid originBoardId: ${originBoardId}. Must be a positive integer.`);
    }

    const sprint = await this.requestAgile<JiraSprint>('POST', '/sprint', {
      body: {
        name,
        originBoardId,
        goal,
        startDate,
        endDate,
      },
    });

    return formatSprint(sprint, this.config.siteUrl, originBoardId);
  }

  /**
   * Update an existing sprint (partial update via POST)
   * Can be used to: rename, set dates, set goal, start sprint, or close sprint
   */
  async updateSprint(params: {
    sprintId: number;
    name?: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
    state?: 'active' | 'closed';
  }): Promise<FormattedSprint> {
    const { sprintId, name, goal, startDate, endDate, state } = params;
    if (!isValidBoardOrSprintId(sprintId)) {
      throw new Error(`Invalid sprintId: ${sprintId}. Must be a positive integer.`);
    }

    // Build only the fields that are provided
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (goal !== undefined) body.goal = goal;
    if (startDate !== undefined) body.startDate = startDate;
    if (endDate !== undefined) body.endDate = endDate;
    if (state !== undefined) body.state = state;

    const sprint = await this.requestAgile<JiraSprint>('POST', `/sprint/${sprintId}`, {
      body,
    });

    return formatSprint(sprint, this.config.siteUrl);
  }

  /**
   * Get issues in a sprint
   */
  async getSprintIssues(params: {
    sprintId: number;
    startAt?: number;
    maxResults?: number;
    jql?: string;
    fields?: string[];
  }): Promise<FormattedSprintIssues> {
    const { sprintId, startAt = 0, maxResults = 50, jql, fields } = params;
    if (!isValidBoardOrSprintId(sprintId)) {
      throw new Error(`Invalid sprintId: ${sprintId}. Must be a positive integer.`);
    }

    const result = await this.requestAgile<JiraSprintIssuesResponse>('GET', `/sprint/${sprintId}/issue`, {
      query: {
        startAt,
        maxResults,
        jql,
        fields: fields?.join(','),
      },
    });

    return formatSprintIssues(result, this.config.siteUrl);
  }

  /**
   * Move issues to a sprint (max 50 issues per request)
   * Issues can only be moved to open or active sprints
   */
  async moveIssuesToSprint(params: { sprintId: number; issues: string[] }): Promise<void> {
    const { sprintId, issues } = params;
    if (!isValidBoardOrSprintId(sprintId)) {
      throw new Error(`Invalid sprintId: ${sprintId}. Must be a positive integer.`);
    }

    if (issues.length === 0) {
      return;
    }

    // Validate issue key format
    const invalidKeys = issues.filter(key => !isValidIssueKey(key));
    if (invalidKeys.length > 0) {
      throw new Error(`Invalid issue key format: ${invalidKeys.join(', ')}`);
    }

    if (issues.length > 50) {
      throw new Error('Maximum 50 issues can be moved to a sprint in one operation. Please split your request.');
    }

    await this.requestAgile<void>('POST', `/sprint/${sprintId}/issue`, {
      body: { issues },
    });
  }
}
