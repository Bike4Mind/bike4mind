import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import type { AgentConfig } from '../storage/types.js';
import type { InteractionMode } from '../bootstrap/types.js';
import { substituteArguments } from '../utils/argumentSubstitution.js';
import { processFileReferences } from '../utils/processFileReferences.js';
import { logger } from '../utils/Logger.js';
import { runShellCommand } from '../utils/shellRunner.js';

/**
 * Parameters for the skill tool
 */
interface SkillParams {
  /** Name of skill to invoke (with or without leading slash) */
  skill: string;
  /** Optional arguments as a space-separated string or quoted strings */
  args?: string;
}

/**
 * Dependencies required by the skill tool
 */
export interface SkillToolDependencies {
  customCommandStore: CustomCommandStore;
  /** Optional: Required for context: fork skills */
  subagentOrchestrator?: SubagentOrchestrator;
  /** Session ID for subagent spawning */
  sessionId?: string;
  /** Optional skill restrictions for this agent context */
  allowedSkills?: string[];
  /**
   * Nesting depth of the agent that owns this tool (main agent = 0). A forking
   * skill spawns its subagent at parentDepth + 1 so the recursion cap applies
   * to skills invoked from within a subagent, not just the delegation tools.
   */
  parentDepth?: number;
  /**
   * Effective interaction mode of the agent that owns this tool. Passed as the
   * ceiling for a forked subagent so it never runs more permissively than its
   * parent. Undefined for the main agent (the fork inherits the live store mode).
   */
  parentInteractionMode?: InteractionMode;
  /**
   * Effective model of the agent that owns this tool. A forked subagent inherits
   * it unless the skill declares its own model.
   */
  parentModel?: string;
}

/**
 * Execute a lifecycle hook script
 *
 * @param script - Shell script to execute
 * @param context - Context variables available to the script
 * @returns Output from the script or error message
 */
async function executeHook(
  script: string,
  context: { skillName: string; args: string; result?: string; error?: string }
): Promise<{ success: boolean; output: string }> {
  const result = await runShellCommand({
    command: script,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    env: {
      ...process.env,
      SKILL_NAME: context.skillName,
      SKILL_ARGS: context.args,
      SKILL_RESULT: context.result || '',
      SKILL_ERROR: context.error || '',
    },
  });

  if (result.timedOut) {
    return { success: false, output: 'Hook failed: timed out after 30s' };
  }

  if (result.exitCode !== 0) {
    return { success: false, output: `Hook failed: ${result.stderr || `exit code ${result.exitCode}`}` };
  }

  return { success: true, output: result.stdout || result.stderr };
}

/**
 * Extract agent name and thoroughness from AgentConfig
 */
function parseAgentConfig(agent: AgentConfig | undefined): {
  name: string;
  thoroughness: 'quick' | 'medium' | 'very_thorough' | undefined;
} {
  if (!agent) {
    return { name: 'general-purpose', thoroughness: undefined };
  }
  if (typeof agent === 'string') {
    return { name: agent, thoroughness: undefined };
  }
  return { name: agent.type, thoroughness: agent.thoroughness };
}

/**
 * Parse arguments string into array, handling quoted strings
 * Examples:
 *   "hello world" -> ["hello", "world"]
 *   '"hello world" test' -> ["hello world", "test"]
 *   "'one two' three" -> ["one two", "three"]
 */
function parseArguments(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = '';
    } else if (!inQuotes && char === ' ') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Create the skill tool for AI-driven skill invocation
 *
 * This tool allows the AI to invoke custom slash commands (skills)
 * from within the conversation. The AI sees available skills in
 * the system prompt and can use this tool to execute them.
 *
 * @param customCommandStore - Store containing loaded custom commands
 * @returns Tool definition compatible with agent tools
 */
export function createSkillTool(deps: SkillToolDependencies): ICompletionOptionTools {
  const { customCommandStore } = deps;

  return {
    toolFn: async (args: unknown) => {
      const params = args as SkillParams;

      if (!params.skill || typeof params.skill !== 'string') {
        throw new Error('skill: skill parameter is required');
      }

      // Normalize skill name (remove leading slash if present)
      const skillName = params.skill.replace(/^\//, '');
      const argsString = params.args || '';

      // Check if skill is allowed for this agent context
      const { allowedSkills } = deps;
      if (allowedSkills && allowedSkills.length > 0) {
        if (!allowedSkills.includes(skillName)) {
          throw new Error(
            `skill: "${skillName}" is not available to this agent. ` + `Allowed skills: ${allowedSkills.join(', ')}`
          );
        }
      }

      const command = customCommandStore.getCommand(skillName);

      if (!command) {
        const available = customCommandStore
          .getAllCommands()
          .map(c => c.name)
          .join(', ');
        throw new Error(`skill: "${skillName}" not found. Available skills: ${available || 'none'}`);
      }

      if (command.hooks?.['pre-invoke']) {
        const hookResult = await executeHook(command.hooks['pre-invoke'], {
          skillName,
          args: argsString,
        });
        if (!hookResult.success) {
          throw new Error(`Pre-invoke hook failed: ${hookResult.output}`);
        }
      }

      try {
        // Parse and substitute arguments
        const argsArray = params.args ? parseArguments(params.args) : [];
        let expandedBody = substituteArguments(command.body, argsArray);

        // Process @file references
        const processed = await processFileReferences(expandedBody);
        expandedBody = processed.content;

        if (processed.errors.length > 0) {
          expandedBody += `\n\n**File reference errors:**\n${processed.errors.map(e => `- ${e}`).join('\n')}`;
        }

        let result: string;

        // Only fork when the skill explicitly requests it via context: fork
        // Skills with just allowedTools or model overrides load inline so the
        // parent agent follows the instructions directly with its own tools.
        // Note: allowedTools is NOT enforced for inline skills - it serves as
        // documentation only. Use context: fork if enforcement is required.
        const needsFork = command.context === 'fork';

        // Warn when allowedTools is declared but won't be enforced
        if (command.allowedTools?.length && !needsFork) {
          logger.debug(
            `Skill "/${skillName}" declares allowedTools but runs inline — ` +
              `tool restrictions are not enforced. Set context: fork to enforce.`
          );
        }

        if (needsFork) {
          const { subagentOrchestrator, sessionId } = deps;

          // Validate dependencies for context fork
          if (!subagentOrchestrator || !sessionId) {
            const missing = !subagentOrchestrator ? 'subagentOrchestrator' : 'sessionId';
            throw new Error(`Skill "${skillName}" requires forked context but ${missing} is not available`);
          }

          // Get agent configuration and delegate to subagent
          const agentConfig = parseAgentConfig(command.agent);
          const agentResult = await subagentOrchestrator.delegateToAgent({
            task: expandedBody,
            agentName: agentConfig.name,
            thoroughness: agentConfig.thoroughness || command.thoroughness,
            variables: command.variables,
            parentSessionId: sessionId,
            // Pass skill-level overrides
            model: command.model,
            allowedTools: command.allowedTools,
            depth: (deps.parentDepth ?? 0) + 1,
            parentInteractionMode: deps.parentInteractionMode,
            parentModel: deps.parentModel,
          });
          const agentName = agentConfig.name;

          // Return summarized result from subagent
          result = `## Skill Executed: /${skillName} (via ${agentName} agent)\n\n${agentResult.summary}`;
        } else {
          // Inline execution - return instructions for AI to follow
          result = `## Skill Loaded: /${skillName}\n\n${expandedBody}\n\n---\n*Follow the instructions above. This skill was invoked programmatically.*`;
        }

        if (command.hooks?.['post-invoke']) {
          const hookResult = await executeHook(command.hooks['post-invoke'], {
            skillName,
            args: argsString,
            result,
          });
          // Log hook output but don't fail on post-invoke errors
          if (!hookResult.success) {
            logger.warn(`Post-invoke hook warning: ${hookResult.output}`);
          }
        }

        return result;
      } catch (error) {
        if (command.hooks?.['on-error']) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const hookResult = await executeHook(command.hooks['on-error'], {
            skillName,
            args: argsString,
            error: errorMessage,
          });
          // Log hook output but don't swallow the original error
          if (hookResult.output) {
            logger.warn(`On-error hook output: ${hookResult.output}`);
          }
        }
        throw error;
      }
    },
    toolSchema: {
      name: 'skill',
      description: `Execute a skill (custom slash command) within the conversation.

**When to use this tool:**
- When a skill would help accomplish the user's request
- When a user asks you to use a skill by name (e.g., "use the review-pr skill")
- When you see /<skill-name> syntax in user messages

**How it works:**
1. Skills are loaded from markdown files in .bike4mind/commands/
2. The skill template is expanded with argument substitution ($1, $2, $ARGUMENTS)
3. File references (@filename) are resolved and content is injected
4. The expanded template is returned for you to follow

**Example invocations:**
- skill({ skill: "commit" }) - invoke commit skill
- skill({ skill: "review-pr", args: "123" }) - review PR #123
- skill({ skill: "feature-code-map", args: "authentication" }) - generate code map

**Important:**
- Skill names can be with or without leading slash: "commit" or "/commit"
- Arguments are space-separated; use quotes for arguments with spaces
- The tool returns instructions to follow, not a final answer`,
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Name of the skill to invoke (e.g., "commit", "review-pr")',
          },
          args: {
            type: 'string',
            description:
              'Optional arguments as space-separated string. Use quotes for arguments containing spaces (e.g., \'123 "bug fix"\').',
          },
        },
        required: ['skill'],
      },
    },
  };
}

export { parseArguments, parseAgentConfig };
