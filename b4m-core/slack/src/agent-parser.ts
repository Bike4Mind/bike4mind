/**
 * Agent Command Parser for Slack Integration
 * Parses natural language commands like "@agent please create a Jira ticket"
 */

import { IModelConfig, IUserDocument, ImageModels } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { TOKEN_EXPIRATION_MS } from './confirmation-token';
import { GitHubResource } from './resources/GitHubResource';
import { JiraResource } from './resources/JiraResource';
import { ConfluenceResource } from './resources/ConfluenceResource';

export type TargetSystem = 'jira' | 'confluence' | 'github' | 'notebook' | 'project' | 'file' | 'image';

export interface ParsedAgentCommand {
  agentName: string | null;
  command: string;
  rawText: string;
}

// Agent registry for different personas
export const AGENT_REGISTRY: Record<string, AgentPersona> = {
  agent: {
    name: 'General Agent',
    description: 'General-purpose assistant',
    systemPrompt:
      'You are a helpful AI assistant integrated with Slack. You can help with various tasks including creating tickets, searching for information, and summarizing conversations.',
    capabilities: ['all'],
  },
  pm: {
    name: 'Project Manager',
    description: 'Handles project management tasks',
    systemPrompt:
      'You are an experienced project manager. You excel at creating well-structured Jira tickets, epics, and Confluence documentation from conversations. You focus on extracting clear requirements, acceptance criteria, and action items.',
    capabilities: ['jira', 'confluence', 'planning', 'requirements'],
    preferredTools: [
      'jira_create',
      'confluence_update_page',
      'confluence_create',
      'confluence_search',
      'jira_bulk_create_issues',
    ],
  },
  dev: {
    name: 'Developer',
    description: 'Technical assistant for development tasks',
    systemPrompt:
      'You are a senior software engineer. You help create detailed GitHub issues, review technical discussions, and extract implementation details from conversations.',
    capabilities: ['github', 'code', 'debugging', 'technical'],
    preferredTools: ['github_create_issue', 'github_search'],
  },
  analyst: {
    name: 'Business Analyst',
    description: 'Business and data analysis',
    systemPrompt:
      'You are a business analyst. You excel at analyzing conversations for insights, creating reports, and identifying patterns in discussions.',
    capabilities: ['analysis', 'reporting', 'insights', 'metrics'],
  },
  researcher: {
    name: 'Research Assistant',
    description: 'Information gathering and research',
    systemPrompt:
      'You are a research assistant. You help find information, search through documentation, and compile comprehensive answers from various sources.',
    capabilities: ['search', 'research', 'documentation'],
    preferredTools: ['confluence_search', 'web_search'],
  },
};

export interface AgentPersona extends IModelConfig {
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  preferredTools?: string[];
}

/**
 * Parse a command from Slack message text
 * Examples:
 * - "@agent please summarize this thread"
 * - "@pm please create a Jira epic from this conversation"
 * - "@dev please create a GitHub issue about the bug Mary mentioned"
 * - "please summarize this thread" (no agent mention - agentName will be null)
 * - "create a GitHub issue" (no agent mention - agentName will be null)
 */
export function parseCommand(text: string): ParsedAgentCommand {
  // Preserve Slack user mentions (<@U123456>) in the command text so assignee
  // extraction can find them later. The @agent_name pattern (e.g. @dev, @pm) is
  // not in <@xxx> format, so we can match it directly.
  const cleanText = text.trim();

  // Match @agent_name at the beginning, possibly after Slack user mentions.
  // Examples: "@dev please help", "<@U12345> @agent please help"
  // Use [\s\S]+ instead of .+ to match newlines in multi-line messages.
  const agentMatch = cleanText.match(/^(?:<@[^>]+>\s*)*@(\w+)\s+([\s\S]+)/);

  let agentKey: string | null;

  if (agentMatch) {
    // Agent mention found - extract agent name but keep the full message as the command
    const [, agentName] = agentMatch;
    agentKey = agentName.toLowerCase();

    // Check if it's a known agent
    if (!AGENT_REGISTRY[agentKey] && agentKey !== 'agent') {
      Logger.globalInstance.log(`Unknown agent name: ${agentName}, treating as general agent`);
    }
  } else {
    agentKey = null;
  }

  // Keep the full message (including @agent mention) as the command
  const command = cleanText;

  return {
    agentName: agentKey,
    command: command.trim(),
    rawText: text,
  };
}

/**
 * Get the appropriate agent persona based on command
 */
export function selectAgent(parsedCommand: ParsedAgentCommand): AgentPersona {
  // If a specific agent was mentioned (not the general 'agent' or null), use it
  if (parsedCommand.agentName && parsedCommand.agentName !== 'agent' && AGENT_REGISTRY[parsedCommand.agentName]) {
    return AGENT_REGISTRY[parsedCommand.agentName];
  }

  // Default to general agent - LLM handles routing via system prompt
  return AGENT_REGISTRY.agent;
}

/**
 * Build a comprehensive prompt for the AI based on the parsed command
 */
export interface BuildSystemPromptOptions {
  /** Pending action awaiting confirmation (from Quest.pendingAction) */
  pendingAction?: {
    tool: string;
    params: Record<string, unknown>;
    ts: number;
  };
  /** Slack channel/thread messages for conversation context */
  channelMessages?: Array<{ bot_id?: string; user?: string; text?: string }>;
  /** Resolve Slack user ID to display name (required when channelMessages is provided) */
  getUserName?: (userId: string) => Promise<string>;
  /** User document for resource instantiation */
  user?: IUserDocument;
  /** Slack user ID of the command sender */
  slackUserId?: string;
  /** Logger instance */
  logger?: Logger;
}

export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
  let prompt = '\n---\n';

  // Slack tool instructions - tell the LLM which tools to call for slash commands
  prompt +=
    '\n---\n' +
    '## Available Slash Commands\n' +
    'When you see these commands in the user message, call the corresponding tool:\n' +
    '- `/help` or "help" → call `slackbot_help` tool\n' +
    '- `/notebook new` or "create a new notebook" → call `notebook_new` tool\n' +
    '- `/notebook status` or "notebook status" → call `notebook_status` tool\n' +
    '- `list files` or "show my files" → call `list_curated_files` tool\n' +
    '- `share file` or `share "filename"` → call `share_curated_file` tool with the fileName parameter';

  // Image generation routing
  prompt +=
    '\n\n---\n' +
    '## Image Generation\n' +
    'When the user asks to generate, create, draw, paint, or render an image/picture/illustration:\n' +
    '- Use the `image_generation` tool directly\n' +
    '- If user specifies a model (e.g., "with flux-pro"), include it in parameters\n';

  // Agent delegation routing
  prompt +=
    '\n\n---\n' +
    '## Agent Routing\n' +
    'When the user mentions an agent, delegate to the corresponding specialized agent:\n' +
    '- `@dev` → delegate to `github_manager` agent\n' +
    '- `@pm` → delegate to `project_manager` agent';

  // Response format
  prompt +=
    '\n\n---\n' + '## Response Format\n' + 'Be concise and actionable. Include links to created/referenced items.';

  // TODO: fix why navigate_view is so aggressive.
  prompt += '\n\nDo not use navigate_view for this — navigate_view is for B4M app UI navigation only.';

  // Resource-specific prompts (GitHub, Jira, Confluence) - always included when user context
  // is available. agentName from @mentions is unreliable; users can ask about GitHub/Jira without
  // an explicit @dev or @pm mention, so all resource contexts are built unconditionally.
  if (options.user && options.logger) {
    try {
      const threadContext = options.channelMessages?.map(m => m.text || '').join('\n') || '';

      const [githubPrompt, jiraPrompt, confluencePrompt] = await Promise.all([
        new GitHubResource(options.user, options.logger)
          .buildAgentPrompt(threadContext, options.slackUserId)
          .catch(err => {
            options.logger?.warn('Failed to build GitHub resource prompt', {
              error: err instanceof Error ? err.message : String(err),
            });
            return '';
          }),
        new JiraResource(options.user, options.logger).buildAgentPrompt().catch(err => {
          options.logger?.warn('Failed to build Jira resource prompt', {
            error: err instanceof Error ? err.message : String(err),
          });
          return '';
        }),
        new ConfluenceResource(options.user, options.logger).buildAgentPrompt().catch(err => {
          options.logger?.warn('Failed to build Confluence resource prompt', {
            error: err instanceof Error ? err.message : String(err),
          });
          return '';
        }),
      ]);

      const resourcePrompt = [githubPrompt, jiraPrompt, confluencePrompt].filter(Boolean).join('\n\n');
      if (resourcePrompt) {
        prompt += '\n\n---\n## Resource Context\n' + resourcePrompt;
      }
    } catch (err) {
      options.logger.warn('Failed to build resource prompts', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Pending action context
  if (options.pendingAction) {
    const pa = options.pendingAction;
    const ageMs = Date.now() - pa.ts;
    const expiresInMs = TOKEN_EXPIRATION_MS - ageMs;
    if (expiresInMs > 0) {
      prompt +=
        `\n\n[PENDING ACTION] A "${pa.tool}" action is awaiting confirmation.\n` +
        `Parameters: ${JSON.stringify(pa.params, null, 2)}\n` +
        `Expires in ${Math.round(expiresInMs / 60000)} minutes.\n` +
        `Use confirm_pending_action to execute, cancel_pending_action to cancel.\n` +
        `To modify: cancel first, then re-invoke the original tool with updated parameters.`;
    }
  }

  // Slack conversation context
  if (options.channelMessages && options.channelMessages.length > 0 && options.getUserName) {
    const getUserName = options.getUserName;
    const userNameCache = new Map<string, string>();
    const lines = await Promise.all(
      options.channelMessages
        .filter(msg => msg.text)
        .slice(-20)
        .map(async msg => {
          if (msg.bot_id) {
            return `[Bot]: ${msg.text}`;
          }
          if (!msg.user) {
            return `[System]: ${msg.text}`;
          }
          if (!userNameCache.has(msg.user)) {
            const userName = await getUserName(msg.user);
            userNameCache.set(msg.user, userName);
          }
          return `${userNameCache.get(msg.user) || 'Unknown'}: ${msg.text}`;
        })
    );
    if (lines.length > 0) {
      prompt += `\n\nRecent Slack conversation:\n${lines.join('\n')}`;
    }
  }

  return prompt;
}

/**
 * Model alias map for inline model override parsing.
 * Maps user-friendly names to ImageModels enum values.
 */
const IMAGE_MODEL_ALIASES: Array<{ pattern: RegExp; model: ImageModels }> = [
  { pattern: /\bflux[\s-]*ultra(?=\s|$)/i, model: ImageModels.FLUX_PRO_ULTRA },
  { pattern: /\bflux[\s-]*pro(?=\s|$)/i, model: ImageModels.FLUX_PRO_1_1 },
  { pattern: /\bflux(?=\s|$)/i, model: ImageModels.FLUX_PRO_1_1 },
  { pattern: /\bgpt[\s-]*image(?=\s|$)/i, model: ImageModels.GPT_IMAGE_1_5 },
  { pattern: /\bopenai(?=\s|$)/i, model: ImageModels.GPT_IMAGE_1_5 },
];

/**
 * Parse an inline model override from the command text.
 * Matches patterns like "with flux-pro", "using grok", "with gpt-image"
 * Returns the model enum value or undefined if no override found.
 */
export function parseImageModelOverride(command: string): ImageModels | undefined {
  // Only detect model overrides when user explicitly says "with <model>" or "using <model>".
  // Without this guard, prompts like "a flux capacitor" would false-positive match "flux".
  const withMatch = command.match(/\b(?:with|using)\s+(.+)/i);
  if (!withMatch) return undefined;

  const searchText = withMatch[1];
  for (const alias of IMAGE_MODEL_ALIASES) {
    if (alias.pattern.test(searchText)) {
      return alias.model;
    }
  }
  return undefined;
}
