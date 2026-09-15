import { IBaseEvent } from '../../../types';

/**
 * Slack integration analytics events
 * Tracks command processing, MCP tool usage, and bulk operations from Slack
 */
export enum SlackEvents {
  /** Fired when a Slack command is received and parsing begins */
  SLACK_COMMAND_RECEIVED = 'Slack Command Received',
  /** Fired when a Slack command completes (success or failure) */
  SLACK_COMMAND_COMPLETED = 'Slack Command Completed',
  /** Fired when an MCP tool is invoked from Slack */
  SLACK_MCP_TOOL_INVOKED = 'Slack MCP Tool Invoked',
  /** Fired when a bulk operation is executed from Slack */
  SLACK_BULK_OPERATION = 'Slack Bulk Operation Executed',

  // Command processing
  COMMAND_PROCESSED = 'Slack Command Processed',
  COMMAND_FAILED = 'Slack Command Failed',

  // Admin actions
  APP_CREATED = 'Slack App Created',
  WORKSPACE_DEACTIVATED = 'Slack Workspace Deactivated',

  // Exports
  CHANNEL_EXPORT_STARTED = 'Slack Channel Export Started',
  CHANNEL_EXPORT_COMPLETED = 'Slack Channel Export Completed',
  CHANNEL_EXPORT_FAILED = 'Slack Channel Export Failed',
}

export interface ISlackCommandProcessedEvent extends IBaseEvent {
  type: SlackEvents.COMMAND_PROCESSED;
  metadata: {
    workspaceId: string;
    channelId: string;
    userId: string;
    agentName: string; // e.g., 'pm', 'dev'
    intent: string; // e.g., 'create', 'search'
    durationMs: number;
    targetSystem?: string; // e.g., 'jira', 'confluence'
  };
}

export interface ISlackCommandFailedEvent extends IBaseEvent {
  type: SlackEvents.COMMAND_FAILED;
  metadata: {
    workspaceId: string;
    channelId: string;
    userId: string;
    agentName?: string;
    error: string;
  };
}

export interface ISlackAppCreatedEvent extends IBaseEvent {
  type: SlackEvents.APP_CREATED;
  metadata: {
    appId?: string;
    appName?: string;
  };
}

export interface ISlackWorkspaceDeactivatedEvent extends IBaseEvent {
  type: SlackEvents.WORKSPACE_DEACTIVATED;
  metadata: {
    workspaceId: string;
    workspaceName: string;
  };
}

export interface ISlackChannelExportStartedEvent extends IBaseEvent {
  type: SlackEvents.CHANNEL_EXPORT_STARTED;
  metadata: {
    workspaceId: string;
    channelId: string;
    format: 'json' | 'csv' | 'markdown';
    isAsync: boolean;
    dateRangePreset?: string;
  };
}

export interface ISlackChannelExportCompletedEvent extends IBaseEvent {
  type: SlackEvents.CHANNEL_EXPORT_COMPLETED;
  metadata: {
    workspaceId: string;
    channelId: string;
    messageCount?: number;
    fileSize?: number;
    durationMs?: number;
  };
}

export interface ISlackChannelExportFailedEvent extends IBaseEvent {
  type: SlackEvents.CHANNEL_EXPORT_FAILED;
  metadata: {
    workspaceId: string;
    channelId: string;
    error: string;
  };
}

/**
 * Event fired when a Slack command is received
 */
interface ISlackCommandReceivedEvent extends IBaseEvent {
  type: SlackEvents.SLACK_COMMAND_RECEIVED;
  metadata: {
    /** Name of the agent handling the command (e.g., 'pm', 'dev', 'analyst') */
    agentName: string;
    /** Detected intent (e.g., 'create', 'search', 'summarize') */
    intent: string;
    /** Target system for the command (e.g., 'github', 'jira', 'notebook') */
    targetSystem: string;
    /** Slack channel ID */
    channel: string;
    /** Whether the message is in a thread */
    isThreaded: boolean;
    /** Whether the message includes file attachments */
    hasFiles: boolean;
  };
}

/**
 * Event fired when a Slack command completes processing
 */
interface ISlackCommandCompletedEvent extends IBaseEvent {
  type: SlackEvents.SLACK_COMMAND_COMPLETED;
  metadata: {
    /** Whether the command completed successfully */
    success: boolean;
    /** Duration of command processing in milliseconds */
    durationMs: number;
    /** Error type if command failed (e.g., 'validation', 'timeout', 'external_service') */
    errorType?: string;
    /** Error message if command failed */
    errorMessage?: string;
  };
}

/**
 * Event fired when an MCP tool is invoked from Slack
 */
interface ISlackMcpToolInvokedEvent extends IBaseEvent {
  type: SlackEvents.SLACK_MCP_TOOL_INVOKED;
  metadata: {
    /** Name of the MCP tool invoked */
    toolName: string;
    /** Whether the tool invocation succeeded */
    success: boolean;
    /** Duration of tool execution in milliseconds */
    durationMs: number;
    /** Type of resource the tool operated on (e.g., 'issue', 'pull_request', 'page') */
    resourceType?: string;
    /** Target system (e.g., 'github', 'jira', 'confluence') */
    targetSystem?: string;
  };
}

/**
 * Event fired when a bulk operation is executed from Slack
 */
interface ISlackBulkOperationEvent extends IBaseEvent {
  type: SlackEvents.SLACK_BULK_OPERATION;
  metadata: {
    /** Type of bulk operation (e.g., 'create_issues', 'update_tickets') */
    operationType: string;
    /** Number of items successfully created/updated */
    itemsSucceeded: number;
    /** Number of items that failed */
    itemsFailed: number;
    /** Target system for the operation */
    targetSystem: string;
    /** Total duration of the bulk operation in milliseconds */
    durationMs: number;
  };
}

export type SlackEventPayload =
  | ISlackCommandReceivedEvent
  | ISlackCommandCompletedEvent
  | ISlackMcpToolInvokedEvent
  | ISlackBulkOperationEvent
  | ISlackCommandProcessedEvent
  | ISlackCommandFailedEvent
  | ISlackAppCreatedEvent
  | ISlackWorkspaceDeactivatedEvent
  | ISlackChannelExportStartedEvent
  | ISlackChannelExportCompletedEvent
  | ISlackChannelExportFailedEvent;
