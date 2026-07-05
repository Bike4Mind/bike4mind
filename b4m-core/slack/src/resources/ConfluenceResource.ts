import { Logger } from '@bike4mind/observability';
import { BaseResource, ConnectionStatus } from './BaseResource';
import { McpServerName, IUserDocument } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from '../di/registry';
import type { EnvVariable } from '../di/types';

/**
 * Parameters for creating a Confluence page
 */
export interface ConfluencePageParams {
  spaceKey: string;
  title: string;
  content: string; // HTML or Confluence storage format
  parentPageId?: string;
  labels?: string[];
}

/**
 * Filters for listing Confluence pages
 */
export interface ConfluenceFilters {
  spaceKey?: string;
  title?: string; // Search by title
  label?: string;
  cql?: string; // Custom CQL query
}

/**
 * Confluence page representation
 */
export interface ConfluencePage {
  id: string;
  title: string;
  content?: string;
  spaceKey: string;
  url: string;
  version?: number;
  labels?: string[];
}

/**
 * ConfluenceResource handles Confluence integration via Atlassian MCP server
 *
 * This includes:
 * - Page creation and listing
 * - Page updates
 * - Confluence connection status
 */
export class ConfluenceResource extends BaseResource {
  private mcpServerCache: unknown | null = null;
  private envVariablesCache: EnvVariable[] | null = null;
  private hasAtlassianConnected: boolean = false;

  constructor(user: IUserDocument, logger: Logger) {
    super(user, logger);
    // Set Atlassian connection status from user document
    this.hasAtlassianConnected = !!user.atlassianConnect?.accessToken;
  }

  /**
   * Check if Confluence/Atlassian is connected for this user
   */
  async isConnected(): Promise<boolean> {
    try {
      const mcpServer = await this.getMcpServer();
      return !!(mcpServer && mcpServer.enabled);
    } catch (error) {
      this.logger.error('Failed to check Confluence connection', {
        userId: this.userId,
        error,
      });
      return false;
    }
  }

  /**
   * Get detailed Confluence connection status
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    try {
      const mcpServer = await this.getMcpServer();

      if (!mcpServer) {
        return {
          connected: false,
          message: 'Atlassian MCP server not configured',
          lastChecked: new Date(),
        };
      }

      if (!mcpServer.enabled) {
        return {
          connected: false,
          message: 'Atlassian MCP server disabled',
          lastChecked: new Date(),
        };
      }

      return {
        connected: true,
        message: 'Confluence connected via Atlassian MCP',
        lastChecked: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to get Confluence connection status', {
        userId: this.userId,
        error,
      });

      return {
        connected: false,
        message: error instanceof Error ? error.message : 'Unknown error',
        lastChecked: new Date(),
      };
    }
  }

  // Agent Prompt Building

  /**
   * Build Confluence-specific agent prompt additions
   *
   * NOTE: DO NOT DUPLICATE PROMPT FROM PROJECT_MANAGER AGENT.
   * This prompt should only include Slack integration related context.
   * If it's not Slack-specific, add the prompt directly to the agent.
   */
  async buildAgentPrompt(): Promise<string> {
    if (this.hasAtlassianConnected) {
      return `### CONFLUENCE RULES

User has connected their Atlassian account. You can now access Jira issues or Confluence pages.

🔧 Use confluence_update_page when the user wants to UPDATE, EDIT, CHANGE, MODIFY, or RENAME an existing page.
IMPORTANT: Do NOT use confluence_create_page for updates - that creates duplicates!
Check the recent conversation for pageId or link from a previous response. Use that pageId to update the page.
You can identify the page using: (1) pageId, (2) link (full Confluence URL)
After updating the page, include the page URL in your Slack message so the user can view the updated page.

Use the confluence_create_page tool to create Confluence pages. Do not just format it as text - call the tool.
NO DOUBLE CONFIRMATION: If the tool supports preview (confirmed=false), use it. Do NOT ask "Do you want me to create this?".

If the user provides table data (markdown tables, formatted tables, or tabular data), you MUST:
1. Extract the EXACT data from the user message - DO NOT generate sample/example data
2. Convert markdown tables to Confluence storage format (HTML tables with <table>, <thead>, <tbody>, <tr>, <th>, <td> tags)
3. Preserve all columns, rows, and cell values exactly as provided by the user

After creating a page, the tool returns a JSON response with page ID and URL. You MUST include the URL in your Slack message. DO NOT generate your own URL.`;
    }

    return `## CONFLUENCE RULES

IMPORTANT: The user has not connected their Atlassian account yet. Inform them they need to connect their Jira and Confluence workspace before you can access Jira issues or Confluence pages.

Provide a friendly message with these steps:
1. Go to Profile page (click profile icon)
2. Navigate to Settings tab
3. Scroll to Connected Apps section
4. Find Atlassian and click the link button
5. Authorize access to your workspace`;
  }

  // Private Helper Methods

  /**
   * Get Atlassian MCP server configuration
   * Uses caching to avoid repeated DB queries
   */
  private async getMcpServer(): Promise<any | null> {
    if (this.mcpServerCache) {
      return this.mcpServerCache;
    }

    const { McpServer } = getSlackDb();
    const mcpServer = await (McpServer as any).findOne({
      userId: this.userId,
      name: McpServerName.Atlassian,
    });

    this.mcpServerCache = mcpServer;
    return mcpServer;
  }

  /**
   * Get MCP environment variables for Atlassian/Confluence integration
   * Uses caching to avoid repeated processing
   */
  async getMcpEnvVariables(): Promise<EnvVariable[]> {
    if (this.envVariablesCache) {
      return this.envVariablesCache;
    }

    const mcpServer = await this.getMcpServer();

    if (!mcpServer) {
      throw new Error('Atlassian MCP server not configured');
    }

    if (!mcpServer.enabled) {
      throw new Error('Atlassian MCP server is disabled');
    }

    const { mcpEnv } = getSlackDeps();
    const envVariables = await mcpEnv.buildMcpEnvVariables(mcpServer);
    this.envVariablesCache = envVariables;

    return envVariables;
  }
}
