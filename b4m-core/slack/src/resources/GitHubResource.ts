import { BaseResource, ConnectionStatus } from './BaseResource';
import { McpServerName } from '@bike4mind/common';
import {
  buildMappingContext,
  extractSlackUserIdsFromText,
  mapSlackUserIdsToGithubUsernames,
  SlackGitHubMapping,
} from '../handlers/slack-github-mapper';
import { getSlackDeps, getSlackDb } from '../di/registry';
import type { EnvVariable } from '../di/types';

/**
 * Parameters for creating a GitHub issue
 */
export interface CreateIssueParams {
  repository: string; // e.g., "owner/repo"
  title: string;
  body?: string;
  assignees?: string[];
  labels?: string[];
}

/**
 * Parameters for creating a GitHub pull request
 */
export interface CreatePRParams {
  repository: string;
  title: string;
  body?: string;
  head: string; // branch name
  base: string; // base branch (usually 'main' or 'master')
  draft?: boolean;
}

/**
 * Filters for listing GitHub issues
 */
export interface IssueFilters {
  repository?: string;
  state?: 'open' | 'closed' | 'all';
  assignee?: string;
  labels?: string[];
}

/**
 * GitHub issue representation
 */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  assignees?: string[];
  labels?: string[];
}

/**
 * GitHub pull request representation
 */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * GitHubResource handles GitHub integration via MCP server
 *
 * This includes:
 * - Repository access and selection
 * - Issue creation and listing
 * - Pull request creation
 * - GitHub connection status
 */
export class GitHubResource extends BaseResource {
  private mcpServerCache: unknown | null = null;
  private envVariablesCache: EnvVariable[] | null = null;

  /**
   * Check if GitHub is connected for this user
   */
  async isConnected(): Promise<boolean> {
    try {
      const mcpServer = await this.getMcpServer();
      return !!(mcpServer && mcpServer.enabled);
    } catch (error) {
      this.logger.error('Failed to check GitHub connection', {
        userId: this.userId,
        error,
      });
      return false;
    }
  }

  /**
   * Get detailed GitHub connection status
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    try {
      const mcpServer = await this.getMcpServer();

      if (!mcpServer) {
        return {
          connected: false,
          message: 'GitHub MCP server not configured',
          lastChecked: new Date(),
        };
      }

      if (!mcpServer.enabled) {
        return {
          connected: false,
          message: 'GitHub MCP server disabled',
          lastChecked: new Date(),
        };
      }

      return {
        connected: true,
        message: 'GitHub connected',
        lastChecked: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to get GitHub connection status', {
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

  // Private Helper Methods

  /**
   * Get GitHub MCP server configuration
   * Uses caching to avoid repeated DB queries
   */
  private async getMcpServer(): Promise<any | null> {
    if (this.mcpServerCache) {
      return this.mcpServerCache;
    }

    const { McpServer } = getSlackDb();
    const mcpServer = await (McpServer as any).findOne({
      userId: this.userId,
      name: McpServerName.Github,
    });

    this.mcpServerCache = mcpServer;
    return mcpServer;
  }

  /**
   * Get MCP environment variables for GitHub integration
   * Used for bulk operations and MCP tool calls
   * Results are cached to avoid repeated DB queries
   */
  async getMcpEnvVariables(): Promise<EnvVariable[]> {
    if (this.envVariablesCache) {
      return this.envVariablesCache;
    }

    const mcpServer = await this.getMcpServer();

    if (!mcpServer) {
      throw new Error('GitHub MCP server not configured');
    }

    if (!mcpServer.enabled) {
      throw new Error('GitHub MCP server is disabled');
    }

    const { mcpEnv } = getSlackDeps();
    const envVariables = await mcpEnv.buildMcpEnvVariables(mcpServer);
    this.envVariablesCache = envVariables;

    return envVariables;
  }

  /**
   * Fetch labels for a repository from GitHub API
   * @param owner - Repository owner
   * @param repo - Repository name
   * @returns Array of label names (lowercase)
   */
  async getRepositoryLabels(owner: string, repo: string): Promise<string[]> {
    try {
      const envVariables = await this.getMcpEnvVariables();
      const tokenVar = envVariables.find(v => v.key === 'GITHUB_ACCESS_TOKEN');
      if (!tokenVar?.value) {
        this.logger.warn('[GitHubResource] No GitHub token found for label validation');
        return [];
      }

      // Add timeout protection for GitHub API call
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      let response: Response;
      try {
        // brand externalized: UA derived from APP_NAME, generic when unset
        const brand = process.env.APP_NAME || '';
        const userAgent = brand ? `${brand}-Slack-Integration` : 'App-Slack-Integration';
        response = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels?per_page=100`, {
          headers: {
            Authorization: `Bearer ${tokenVar.value}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': userAgent,
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          this.logger.warn('[GitHubResource] Labels fetch timed out after 10s', {
            repo: `${owner}/${repo}`,
          });
          return [];
        }
        throw fetchError;
      }

      if (!response.ok) {
        this.logger.warn('[GitHubResource] Failed to fetch repo labels', {
          status: response.status,
          repo: `${owner}/${repo}`,
        });
        return [];
      }

      const labels = (await response.json()) as Array<{ name: string }>;
      return labels.map(l => l.name.toLowerCase());
    } catch (error) {
      this.logger.error('[GitHubResource] Error fetching repo labels', { error, repo: `${owner}/${repo}` });
      return [];
    }
  }

  /**
   * Validate and filter labels to only include existing ones
   * @param labels - Labels to validate
   * @param repoLabels - Existing labels in repo (lowercase)
   * @returns Object with valid and skipped labels
   */
  validateLabels(labels: string[], repoLabels: string[]): { valid: string[]; skipped: string[] } {
    const valid = labels.filter(l => repoLabels.includes(l.toLowerCase()));
    const skipped = labels.filter(l => !repoLabels.includes(l.toLowerCase()));
    return { valid, skipped };
  }

  // Agent Prompt Building

  /**
   * Build GitHub-specific agent prompt additions
   *
   * NOTE: DO NOT DUPLICATE PROMPT FROM GITHUB_MANAGER AGENT.
   * This prompt should only include Slack integration related context.
   * If it's not Slack-specific, add the prompt directly to the agent.
   */
  async buildAgentPrompt(threadContext?: string, slackUserId?: string): Promise<string> {
    let prompt = '### GITHUB RULES';
    let hasMappings = false;

    // Collect all Slack User IDs: current user + any mentioned in thread
    const slackUserIds = new Set<string>();
    if (slackUserId) {
      slackUserIds.add(slackUserId);
    }
    if (threadContext) {
      for (const id of extractSlackUserIdsFromText(threadContext)) {
        slackUserIds.add(id);
      }
    }

    if (slackUserIds.size > 0) {
      const mappings = await mapSlackUserIdsToGithubUsernames([...slackUserIds]);
      hasMappings = mappings.some(m => m.githubUsername !== null);
      if (hasMappings) {
        prompt += buildMappingContext(mappings) + '\n';
      }
    }

    prompt += `
📋 ASSIGNEE HANDLING:
- If a GitHub username is mentioned directly (e.g., "assign to octocat"), use it as-is for the assignee
- If a Slack user is mentioned, use the Slack-to-GitHub mapping above to find their GitHub username
- Only assign if explicitly requested in the command or thread context

🚫 ASSIGNMENT RULE FOR CREATE:
ONLY include assignees if the user EXPLICITLY specifies WHO to assign in their CURRENT command.
Valid assignment phrases: "assign to @user", "assign to me", "assigned to jarlacut"
If the user just says "create issue for X" without specifying an assignee, leave assignees EMPTY.
The word "assign" in a title/description (e.g., "testing assign feature") is NOT an assignment request.
Do NOT infer assignment from thread context or previous commands.

❌ DO NOT use jira_create_issue or Jira parameters like "projectKey", "summary"

⚠️ CRITICAL - SLACK USER ID HANDLING:
1. Do NOT use Slack User IDs (format: @U06VC17UUEN or U06VC17UUEN) as assignees. Slack User IDs are NOT valid GitHub usernames.
2. Do NOT include Slack User IDs in issue body/description. Convert to generic language like "Team member will handle X".
3. Only use actual GitHub usernames for assignees. If unsure of someone's GitHub username, leave the assignees field empty.`;

    if (!hasMappings) {
      prompt += `

⚠️ CRITICAL: No user-to-GitHub mapping is available. You MUST leave the assignees field EMPTY (do not assign to anyone).
Only assign if the user explicitly provides a valid GitHub username in their command (e.g., "assign to octocat").`;
    }

    prompt += `

📊 TABLE DATA HANDLING:
If the user provides table data (markdown tables, formatted tables, or tabular data), you MUST:
1. Extract the EXACT data from the user message - DO NOT generate sample/example data
2. Include tables in the issue body using GitHub-flavored markdown table format
3. Preserve all columns, rows, and cell values exactly as provided by the user

📍 FINDING THE ISSUE NUMBER:
1. Check if user specified an issue number (e.g., "#15", "issue 15")
2. If not specified, look at the thread context for recently created/mentioned issues
   - Bot messages like "[Bot]: ✅ Created Issue #15" indicate the issue number
   - Use the most recently mentioned issue if context is clear
3. If still unclear, ask the user which issue they mean

👤 FINDING THE ASSIGNEE:
1. If user says "assign to <@UXXXXXXXX>", look up the GitHub username in the SLACK-TO-GITHUB MAPPING above
2. If user says "assign to me", use the command sender's GitHub username from the mapping
3. Use the EXACT GitHub username from the mapping (e.g., "jarlacut"), NOT the Slack ID`;

    return prompt;
  }

  /**
   * Maps a single Slack User ID to GitHub username
   * @param slackUserId - The Slack User ID (e.g., "U09JUQJ2KHC")
   * @returns GitHub username if found, null otherwise
   */
  async mapSlackUserIdToGithubUsername(slackUserId: string): Promise<SlackGitHubMapping> {
    try {
      const { User, McpServer } = getSlackDb();
      // Find user by Slack User ID
      const user = await (User as any).findOne({ 'slackSettings.slackUserId': slackUserId });

      if (!user) {
        this.logger.debug(`[slack-github-mapper] No user found for Slack User ID: ${slackUserId}`);
        return {
          slackUserId,
          githubUsername: null,
        };
      }

      this.logger.debug(`[slack-github-mapper] Found user for Slack ID ${slackUserId}:`, {
        userId: user.id,
        userName: user.name,
      });

      // Find GitHub MCP server for this user
      const githubMcpServer = await (McpServer as any).findOne({
        userId: user.id,
        name: McpServerName.Github,
        enabled: true,
      });

      if (!githubMcpServer || !githubMcpServer.metadata?.githubLogin) {
        this.logger.debug(`[slack-github-mapper] User ${user.id} does not have GitHub connected`);
        return {
          slackUserId,
          githubUsername: null,
          userDisplayName: user.name,
        };
      }

      this.logger.debug(`[slack-github-mapper] ✅ Mapped ${slackUserId} → ${githubMcpServer.metadata.githubLogin}`);
      return {
        slackUserId,
        githubUsername: githubMcpServer.metadata.githubLogin,
        userDisplayName: user.name,
      };
    } catch (error) {
      this.logger.error(`[slack-github-mapper] Error mapping Slack User ID ${slackUserId}:`, error);
      return {
        slackUserId,
        githubUsername: null,
      };
    }
  }
}
