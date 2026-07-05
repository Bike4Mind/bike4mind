import { Logger } from '@bike4mind/observability';
import { BaseResource, ConnectionStatus } from './BaseResource';
import { McpServerName, IUserDocument } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from '../di/registry';
import type { EnvVariable } from '../di/types';

/**
 * Parameters for creating a Jira issue
 */
export interface JiraIssueParams {
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string; // e.g., "Task", "Bug", "Story"
  priority?: string; // e.g., "High", "Medium", "Low"
  assignee?: string;
  labels?: string[];
}

/**
 * Filters for listing Jira issues
 */
export interface JiraFilters {
  projectKey?: string;
  assignee?: string;
  status?: string; // e.g., "To Do", "In Progress", "Done"
  issueType?: string;
  labels?: string[];
  jql?: string; // Custom JQL query
}

/**
 * Jira issue representation
 */
export interface JiraIssue {
  id: string;
  key: string; // e.g., "PROJ-123"
  summary: string;
  description?: string;
  status: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  url: string;
  labels?: string[];
}

/**
 * JiraResource handles Jira integration via Atlassian MCP server
 */
export class JiraResource extends BaseResource {
  private mcpServerCache: unknown | null = null;
  private envVariablesCache: EnvVariable[] | null = null;
  private hasAtlassianConnected: boolean = false;

  constructor(user: IUserDocument, logger: Logger) {
    super(user, logger);
    // Set Atlassian connection status from user document
    this.hasAtlassianConnected = !!user.atlassianConnect?.accessToken;
  }

  /**
   * Check if Jira/Atlassian is connected for this user
   */
  async isConnected(): Promise<boolean> {
    try {
      const mcpServer = await this.getMcpServer();
      return !!(mcpServer && mcpServer.enabled);
    } catch (error) {
      this.logger.error('Failed to check Jira connection', {
        userId: this.userId,
        error,
      });
      return false;
    }
  }

  /**
   * Get detailed Jira connection status
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
        message: 'Jira connected via Atlassian MCP',
        lastChecked: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to get Jira connection status', {
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
   * Build Jira-specific agent prompt additions
   *
   * NOTE: DO NOT DUPLICATE PROMPT FROM PROJECT_MANAGER AGENT.
   * This prompt should only include Slack integration related context.
   * If it's not Slack-specific, add the prompt directly to the agent.
   */
  async buildAgentPrompt(): Promise<string> {
    const email = this.user.email || 'unknown';
    const siteName = this.user.atlassianConnect?.siteName || 'unknown';

    if (this.hasAtlassianConnected) {
      return `### JIRA RULES

User has connected their Atlassian account (Email: ${email}, Site: ${siteName}). You can now access Jira issues or Confluence pages.

🚨 CRITICAL - TOOL SELECTION:
For JIRA tickets, use jira_create_issue from the atlassian server.
DO NOT use GitHub create_issue - that is for GitHub only.

IMPORTANT: Use the jira_create_issue tool with confirmed=false. Do not just format it as text - call the tool.

NO DOUBLE CONFIRMATION: The tool will automatically generate a preview with Confirm/Cancel buttons.
DO NOT ask the user "Do you want me to create this?" or "Proceed?". Just call the tool with confirmed=false.

SUBTASKS & MULTIPLE ISSUES:
If the user asks to create multiple issues or subtasks:
1. You MUST call the tool multiple times or use jira_bulk_create_issues if available.
2. For subtasks, ensure you set the \`parentKey\` parameter to the parent issue key.
3. DO NOT create just one issue if the user asked for multiple.

CONTENT GENERATION:
If the user asks you to "make up" a description or generate content:
1. You ARE AUTHORIZED to creatively generate realistic and detailed descriptions/summaries.
2. Do not ask for confirmation on the content unless it is ambiguous.
3. Use your generated content in the tool parameters.

OUTPUT ACCURACY:
1. ALWAYS use the \`key\` and \`link\` returned by the tool execution. Do NOT guess or reuse keys from context.
2. When creating a subtask, the new issue key will be different from the parent key.
3. If the tool fails (e.g. parent not found), report the error. DO NOT generate a fake success message.

📊 TABLE DATA HANDLING:
If the user provides table data (markdown tables, formatted tables, or tabular data), you MUST:
1. Extract the EXACT data from the user message - DO NOT generate sample/example data
2. Convert tables to Jira wiki markup format: ||Header1||Header2||\\n|Value1|Value2|
3. Preserve all columns, rows, and cell values exactly as provided by the user`;
    }

    return `## JIRA RULES

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
   * Get MCP environment variables for Atlassian/Jira integration
   * Used for bulk operations and MCP tool calls
   * Results are cached to avoid repeated DB queries
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
