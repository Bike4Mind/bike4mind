import { BaseResource, ConnectionStatus } from './BaseResource';
import { IUserDocument } from '@bike4mind/common';
import { getSlackDb } from '../di/registry';

/**
 * InternalResource handles interactions with internal database models
 * and file storage operations.
 *
 * File listing and sharing logic lives in the tools/ directory
 * (listCuratedFiles, shareCuratedFile) and is delegated to from here.
 */
export class InternalResource extends BaseResource {
  private userCache: IUserDocument | null = null;

  /**
   * Internal resources are always "connected" since they're part of the app
   */
  async isConnected(): Promise<boolean> {
    return true;
  }

  /**
   * Get connection status for internal resources
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    return {
      connected: true,
      message: 'Internal resources always available',
      lastChecked: new Date(),
    };
  }

  /**
   * Get the user for this resource instance
   * Uses caching to avoid repeated DB queries
   */
  async getUser(): Promise<IUserDocument> {
    if (this.userCache) {
      return this.userCache;
    }

    const { User } = getSlackDb();
    const user = await (User as any).findById(this.userId);
    if (!user) {
      throw new Error(`User not found: ${this.userId}`);
    }

    this.userCache = user;
    return user;
  }

  // Agent Prompt Building

  /**
   * Build internal resource-specific agent prompt additions
   *
   * NOTE: DO NOT DUPLICATE PROMPT FROM THE CORRESPONDING AGENT.
   * This prompt should only include Slack integration related context.
   * If it's not Slack-specific, add the prompt directly to the agent.
   */
  async buildAgentPrompt(): Promise<string> {
    return `### INTERNAL RULES

📂 INTERNAL RESOURCE ACCESS:
You have access to the user's internal resources (files, notebooks, projects).`;
  }
}
