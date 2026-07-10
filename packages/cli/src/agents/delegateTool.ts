import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ThoroughnessLevel } from '@bike4mind/agents';
import type { SubagentOrchestrator } from './SubagentOrchestrator.js';
import type { AgentStore } from './AgentStore.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';

/**
 * Parameters for the agent_delegate tool
 */
interface AgentDelegateParams {
  /** Task description for the agent */
  task: string;
  /** Name of the agent to use */
  agent: string;
  /** How thoroughly to execute the task */
  thoroughness?: ThoroughnessLevel;
  /** Custom variables to substitute in agent system prompt */
  variables?: Record<string, string>;
  /** Run agent in background (non-blocking). Use check_agent_status to get results. */
  run_in_background?: boolean;
  /** Short description of what this group of background agents is working on */
  group_description?: string;
}

/**
 * Create the agent_delegate tool
 *
 * This tool allows the main agent to delegate tasks to specialized agents
 * loaded from markdown definitions. Agents can be built-in, global, or project-specific.
 *
 * @param orchestrator - The SubagentOrchestrator instance
 * @param agentStore - The AgentStore for accessing agent definitions
 * @param parentSessionId - Current session ID
 * @returns Tool definition compatible with agent tools
 */
export function createAgentDelegateTool(
  orchestrator: SubagentOrchestrator,
  agentStore: AgentStore,
  parentSessionId: string,
  backgroundManager?: BackgroundAgentManager,
  /** Nesting depth of the agent that owns this tool (main agent = 0). Spawns run at parentDepth + 1. */
  parentDepth = 0
): ICompletionOptionTools {
  // Build dynamic agent list for tool description
  const agents = agentStore.getAllAgents();
  const agentDescriptions = agents.map(a => `- **${a.name}**: ${a.description}`).join('\n');

  // Get agent names for enum validation
  const agentNames = agentStore.getAgentNames();

  return {
    toolFn: async (args: unknown) => {
      const params = args as AgentDelegateParams;

      if (!params.task) {
        throw new Error('agent_delegate: task parameter is required');
      }

      if (!params.agent) {
        throw new Error('agent_delegate: agent parameter is required');
      }

      // Validate agent exists
      if (!agentStore.hasAgent(params.agent)) {
        const available = agentNames.join(', ');
        throw new Error(`agent_delegate: unknown agent "${params.agent}". Available agents: ${available}`);
      }

      const spawnOptions = {
        task: params.task,
        agentName: params.agent,
        thoroughness: params.thoroughness,
        variables: params.variables,
        parentSessionId,
        depth: parentDepth + 1,
      };

      // Background execution: return job ID immediately
      if (params.run_in_background && backgroundManager) {
        const jobId = backgroundManager.spawn({
          ...spawnOptions,
          groupDescription: params.group_description,
        });
        return `Background agent started. Job ID: ${jobId}. Use check_agent_status tool with this job ID to retrieve results when ready.`;
      }

      // Foreground execution (default): block until complete
      const result = await orchestrator.delegateToAgent(spawnOptions);
      return result.summary;
    },
    toolSchema: {
      name: 'agent_delegate',
      description: `Delegate a task to a specialized agent for focused work.

**Available Agents:**
${agentDescriptions}

**When to use this tool:**
- **explore**: When you need to search through the codebase, find files, or understand code structure (read-only)
- **plan**: When you need to break down a complex task into actionable steps
- **review**: When you need to analyze code quality and identify potential issues
- Custom agents: Use for domain-specific tasks defined in project or global agent files

**Benefits:**
- Keeps main conversation focused and clean
- Uses specialized prompts optimized for each task type
- Faster execution with appropriate models (Haiku for explore/plan, Sonnet for review)
- Supports custom variables for parameterized behavior

**Example uses:**
- "Find all files that use the authentication system" → agent: explore
- "Search for components that handle user input" → agent: explore
- "Break down implementing a new feature into steps" → agent: plan
- "Review this module for potential bugs" → agent: review`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              "Clear description of what you want the agent to do. Be specific about what you're looking for or what needs to be accomplished.",
          },
          agent: {
            type: 'string',
            enum: agentNames,
            description: `Name of the agent to use for this task. Available: ${agentNames.join(', ')}`,
          },
          thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'very_thorough'],
            description: `How thoroughly to execute:
- quick: Fast lookup, fewest iterations
- medium: Balanced exploration (default)
- very_thorough: Comprehensive analysis, maximum iterations`,
          },
          variables: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Custom variables to substitute in agent system prompt. For example: { "DOMAIN": "authentication", "STRICTNESS": "high" }',
          },
          run_in_background: {
            type: 'boolean',
            description:
              'Run the agent in the background (non-blocking). Returns a job ID immediately. Use check_agent_status to poll for results. Useful for parallel work or long-running tasks.',
          },
          group_description: {
            type: 'string',
            description:
              'Short description of what this group of background agents is working on (e.g., "Implementing user authentication"). Only needed for the first background agent in a group. All background agents spawned in the same turn are automatically grouped.',
          },
        },
        required: ['task', 'agent'],
      },
    },
  };
}
