import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ThoroughnessLevel } from '@bike4mind/agents';
import type { SubagentOrchestrator } from './SubagentOrchestrator.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_THOROUGHNESS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_RETRY_CONFIG,
  ALWAYS_DENIED_FOR_AGENTS,
} from './types.js';

/**
 * Parameters for the create_dynamic_agent tool
 */
interface DynamicAgentParams {
  /** Task description for the agent */
  task: string;
  /** Unique name for this dynamic agent */
  name: string;
  /** Custom system prompt for the agent */
  systemPrompt: string;
  /** Short description of the agent's purpose */
  description?: string;
  /** Model to use (defaults to agent default) */
  model?: string;
  /** Allowed tools whitelist (wildcard patterns supported) */
  allowedTools?: string[];
  /** Denied tools blacklist (wildcard patterns supported) */
  deniedTools?: string[];
  /** Thoroughness level */
  thoroughness?: ThoroughnessLevel;
  /** Variables to substitute in system prompt */
  variables?: Record<string, string>;
  /** Run agent in background (non-blocking) */
  run_in_background?: boolean;
  /** Short description for grouped background notifications */
  group_description?: string;
}

/**
 * Create the create_dynamic_agent tool
 *
 * This tool allows the main agent to create and spawn a one-off agent at runtime
 * with a custom system prompt, model, and tool restrictions. Unlike agent_delegate,
 * this does not require a pre-defined agent markdown file.
 *
 * @param orchestrator - The SubagentOrchestrator instance
 * @param parentSessionId - Current session ID
 * @param backgroundManager - Optional background manager for async execution
 * @returns Tool definition compatible with agent tools
 */
export function createDynamicAgentTool(
  orchestrator: SubagentOrchestrator,
  parentSessionId: string,
  backgroundManager?: BackgroundAgentManager
): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const params = args as DynamicAgentParams;

      if (!params.task) {
        throw new Error('create_dynamic_agent: task parameter is required');
      }
      if (!params.name) {
        throw new Error('create_dynamic_agent: name parameter is required');
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(params.name)) {
        throw new Error(
          'create_dynamic_agent: name must contain only alphanumeric characters, hyphens, and underscores'
        );
      }
      if (!params.systemPrompt) {
        throw new Error('create_dynamic_agent: systemPrompt parameter is required');
      }

      // Build denied tools: ALWAYS_DENIED_FOR_AGENTS includes agent_delegate and create_dynamic_agent
      const deniedTools = [...(params.deniedTools || []), ...ALWAYS_DENIED_FOR_AGENTS];

      // Build inline agent definition
      const agentDefinition = {
        description: params.description || `Dynamic agent: ${params.name}`,
        model: params.model || DEFAULT_AGENT_MODEL,
        modelResolved: true, // Dynamic agents always have an explicitly provided or default model
        systemPrompt: params.systemPrompt,
        allowedTools: params.allowedTools,
        deniedTools,
        maxIterations: { ...DEFAULT_MAX_ITERATIONS },
        defaultThoroughness: DEFAULT_THOROUGHNESS,
        defaultVariables: params.variables,
        retry: { ...DEFAULT_RETRY_CONFIG },
      };

      const spawnOptions = {
        task: params.task,
        agentName: params.name,
        thoroughness: params.thoroughness,
        variables: params.variables,
        parentSessionId,
        model: params.model,
        allowedTools: params.allowedTools,
        agentDefinition,
      };

      // Background execution: return job ID immediately
      if (params.run_in_background && backgroundManager) {
        const jobId = backgroundManager.spawn({
          ...spawnOptions,
          groupDescription: params.group_description,
        });
        return `Dynamic background agent "${params.name}" started. Job ID: ${jobId}. Use check_agent_status tool with this job ID to retrieve results when ready.`;
      }

      // Foreground execution (default): block until complete
      const result = await orchestrator.delegateToAgent(spawnOptions);
      return result.summary;
    },
    toolSchema: {
      name: 'create_dynamic_agent',
      description: `Create and spawn a one-off agent at runtime with a custom system prompt.

Unlike agent_delegate (which uses pre-defined agents), this tool lets you compose a new agent on the fly with custom instructions, model, and tool restrictions.

**When to use this tool:**
- When no existing agent fits the task at hand
- When you need a specialized agent with custom instructions for a one-off task
- When you need fine-grained control over what tools the agent can access

**Constraints:**
- Dynamic agents CANNOT call agent_delegate or create_dynamic_agent (no recursive spawning)
- Dynamic agents are ephemeral — they are not saved or reusable across sessions

**Example uses:**
- Create a security auditor agent with specific review criteria
- Create a migration agent that follows a custom checklist
- Create a specialized code generator with domain-specific instructions`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Clear description of what you want the dynamic agent to accomplish.',
          },
          name: {
            type: 'string',
            description:
              'Unique name for this dynamic agent (e.g., "security-auditor", "migration-helper"). Used for logging and identification.',
          },
          systemPrompt: {
            type: 'string',
            description:
              "Custom system prompt for the agent. This defines the agent's role, capabilities, and constraints. Use $TASK to reference the task parameter.",
          },
          description: {
            type: 'string',
            description: "Short description of the agent's purpose (for logging).",
          },
          model: {
            type: 'string',
            description:
              'Model to use for this agent (e.g., "claude-sonnet-4-5-20250929"). Defaults to the agent system default.',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Whitelist of tool name patterns the agent can use. Supports wildcards (e.g., "file_*", "mcp__github__*"). If omitted, all non-denied tools are available.',
          },
          deniedTools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Blacklist of tool name patterns the agent cannot use. agent_delegate and create_dynamic_agent are always denied.',
          },
          thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'very_thorough'],
            description: `How thoroughly to execute:
- quick: Fast, 1-2 iterations
- medium: Balanced, 3-5 iterations (default)
- very_thorough: Comprehensive, 8-10+ iterations`,
          },
          variables: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Variables to substitute in the system prompt. For example: { "DOMAIN": "auth" } replaces $DOMAIN in the prompt.',
          },
          run_in_background: {
            type: 'boolean',
            description:
              'Run the agent in the background (non-blocking). Returns a job ID immediately. Use check_agent_status to poll for results.',
          },
          group_description: {
            type: 'string',
            description:
              'Short description of what this group of background agents is working on. Only needed for the first background agent in a group.',
          },
        },
        required: ['task', 'name', 'systemPrompt'],
      },
    },
  };
}
