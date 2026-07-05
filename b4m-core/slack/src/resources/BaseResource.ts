import { Logger } from '@bike4mind/observability';
import { IUserDocument } from '@bike4mind/common';

/**
 * Connection status for a resource integration
 */
export interface ConnectionStatus {
  connected: boolean;
  message?: string;
  lastChecked?: Date;
}

/**
 * Base interface for all resource integrations
 * Provides a consistent interface for interacting with 3rd party services
 * and internal resources (GitHub, Jira, Confluence, Internal DB, etc.)
 */
export interface IResource {
  /**
   * Check if the resource integration is connected/authenticated
   */
  isConnected(): Promise<boolean>;

  /**
   * Get detailed connection status
   */
  getConnectionStatus(): Promise<ConnectionStatus>;

  /**
   * Build resource-specific agent prompt additions
   *
   * NOTE: DO NOT DUPLICATE PROMPT FROM THE CORRESPONDING AGENT.
   * This prompt should only include Slack integration related context.
   * If it's not Slack-specific, add the prompt directly to the agent.
   *
   * @param threadContext - Thread context text for Slack-to-GitHub user mapping
   * @param slackUserId - Current Slack user ID for command sender mapping
   * @returns Prompt string to add to the system prompt
   */
  buildAgentPrompt(threadContext?: string, slackUserId?: string): Promise<string>;
}

/**
 * Base class for resource implementations
 * Provides common functionality like logging and user context
 */
export abstract class BaseResource implements IResource {
  protected user: IUserDocument;
  protected userId: string;
  protected logger: Logger;

  constructor(user: IUserDocument, logger: Logger) {
    this.user = user;
    this.userId = user.id;
    this.logger = logger;
  }

  abstract isConnected(): Promise<boolean>;
  abstract getConnectionStatus(): Promise<ConnectionStatus>;
  abstract buildAgentPrompt(threadContext?: string, slackUserId?: string): Promise<string>;

  // Optional delete method
  async delete?(id: string): Promise<void>;
}
