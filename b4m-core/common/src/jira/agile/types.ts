// Agile/Sprint Types for Jira Software
// These types are used by the Agile REST API 1.0

import type { JiraIssue } from '../api';

export type JiraBoardType = 'scrum' | 'kanban' | 'simple';

export interface JiraBoard {
  id: number;
  name: string;
  type: JiraBoardType;
  self?: string;
  location?: {
    projectId?: number;
    projectKey?: string;
    projectName?: string;
    displayName?: string;
    projectTypeKey?: string;
  };
}

export interface JiraBoardListResponse {
  maxResults: number;
  startAt: number;
  total?: number;
  isLast: boolean;
  values: JiraBoard[];
}

/**
 * Status mapping within a board column.
 * Maps Jira workflow statuses to board columns.
 */
export interface JiraBoardColumnStatus {
  id: string;
  self?: string;
}

/**
 * Board column configuration.
 * Represents a column on the board with its status mappings and optional WIP limits.
 */
export interface JiraBoardColumn {
  name: string;
  statuses: JiraBoardColumnStatus[];
  min?: number; // WIP limit minimum (Kanban boards)
  max?: number; // WIP limit maximum (Kanban boards)
}

/**
 * Column configuration for a board.
 */
export interface JiraBoardColumnConfig {
  columns: JiraBoardColumn[];
  constraintType?: 'none' | 'issueCount' | 'issueCountExclSubs';
}

/**
 * Estimation configuration for a board.
 */
export interface JiraBoardEstimation {
  type: string;
  field?: {
    fieldId: string;
    displayName: string;
  };
}

/**
 * Ranking configuration for a board.
 */
export interface JiraBoardRanking {
  rankCustomFieldId: number;
}

/**
 * Filter configuration for a board.
 */
export interface JiraBoardFilter {
  id: string;
  name?: string;
  self?: string;
}

/**
 * Sub-query configuration containing the board's base JQL filter.
 */
export interface JiraBoardSubQuery {
  query: string;
}

/**
 * Full board configuration response from the Jira Agile API.
 * Contains columns, WIP limits, estimation settings, and filter info.
 */
export interface JiraBoardConfiguration {
  id: number;
  name: string;
  type: JiraBoardType;
  self?: string;
  filter?: JiraBoardFilter;
  subQuery?: JiraBoardSubQuery;
  columnConfig: JiraBoardColumnConfig;
  estimation?: JiraBoardEstimation;
  ranking?: JiraBoardRanking;
}

/**
 * Response from GET /board/{boardId}/issue endpoint.
 * Returns issues visible on the board.
 */
export interface JiraBoardIssuesResponse {
  maxResults: number;
  startAt: number;
  total: number;
  issues: import('../api').JiraIssue[];
}

export type JiraSprintState = 'future' | 'active' | 'closed';

export interface JiraSprint {
  id: number;
  name: string;
  state: JiraSprintState;
  self?: string;
  originBoardId?: number;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

export interface JiraSprintListResponse {
  maxResults: number;
  startAt: number;
  isLast: boolean;
  values: JiraSprint[];
}

export interface JiraSprintIssuesResponse {
  maxResults: number;
  startAt: number;
  total: number;
  issues: JiraIssue[];
}

/**
 * Formatted board with essential fields only.
 * Used as return type for formatBoard().
 */
export interface FormattedBoard {
  id: number;
  name: string;
  type: JiraBoardType;
  link: string;
  project?: {
    key: string;
    name: string;
  };
}

/**
 * Formatted board list with pagination info.
 * Used as return type for formatBoardList().
 */
export interface FormattedBoardList {
  total?: number;
  startAt: number;
  maxResults: number;
  isLast: boolean;
  boards: FormattedBoard[];
}

/**
 * Formatted sprint with essential fields only.
 * Used as return type for formatSprint().
 */
export interface FormattedSprint {
  id: number;
  name: string;
  state: JiraSprintState;
  goal?: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId?: number;
  link?: string;
}

/**
 * Formatted sprint list with pagination info.
 * Used as return type for formatSprintList().
 */
export interface FormattedSprintList {
  startAt: number;
  maxResults: number;
  isLast: boolean;
  sprints: FormattedSprint[];
}

/**
 * Formatted issue details with essential fields only.
 * Used within sprint issues response.
 */
export interface FormattedIssueDetails {
  id: string;
  key: string;
  link: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority?: string;
  assignee: {
    accountId: string;
    displayName: string;
  } | null;
  reporter: {
    accountId: string;
    displayName: string;
  } | null;
  created?: string;
  updated?: string;
  project?: {
    key: string;
    name: string;
  };
  subtasks?: Array<{
    id: string;
    key: string;
    link: string;
  }>;
}

/**
 * Formatted sprint issues response with pagination info.
 * Used as return type for formatSprintIssues().
 */
export interface FormattedSprintIssues {
  total: number;
  startAt: number;
  maxResults: number;
  issues: FormattedIssueDetails[];
}

/**
 * Formatted column with essential fields for AI.
 */
export interface FormattedBoardColumn {
  name: string;
  statusIds: string[];
  min?: number; // WIP limit minimum
  max?: number; // WIP limit maximum
}

/**
 * Formatted board configuration for AI consumption.
 * Used as return type for formatBoardConfiguration().
 */
export interface FormattedBoardConfiguration {
  id: number;
  name: string;
  type: JiraBoardType;
  link: string;
  filter?: {
    id: string;
    name?: string;
  };
  jqlFilter?: string; // The board's base JQL filter from subQuery
  columns: FormattedBoardColumn[];
  constraintType?: 'none' | 'issueCount' | 'issueCountExclSubs';
  estimation?: {
    type: string;
    fieldName?: string;
  };
  rankingFieldId?: number;
}

/**
 * Grouping options for board issues.
 */
export type BoardIssueGroupBy = 'status' | 'assignee' | 'epic';

/**
 * Formatted board issues response with optional grouping.
 * Used as return type for formatBoardIssues().
 */
export interface FormattedBoardIssues {
  total: number;
  startAt: number;
  maxResults: number;
  issues: FormattedIssueDetails[];
  groupedBy?: BoardIssueGroupBy;
  groups?: Array<{
    key: string;
    name: string;
    issues: FormattedIssueDetails[];
  }>;
}
