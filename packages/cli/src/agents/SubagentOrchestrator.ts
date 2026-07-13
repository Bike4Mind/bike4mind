/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { ReActAgent } from '@bike4mind/agents';
import type { AgentResult, ThoroughnessLevel } from '@bike4mind/agents';
import type { IMessage } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { PermissionManager } from '../utils/PermissionManager.js';
import type { PermissionResponse } from '../components/PermissionPrompt.js';
import type { ApiClient } from '../auth/ApiClient.js';
import { withRetry, isRetryableError } from '@bike4mind/utils';
import {
  generateCliTools,
  wrapToolWithHooks,
  type AgentContext,
  type ToolFilter,
  type HookWrapperContext,
  type UserQuestionPayload,
  type UserQuestionResponse,
} from '../utils/toolsAdapter.js';
import type { AgentStore } from './AgentStore.js';
import type { AgentDefinition } from './types.js';
import { ALWAYS_DENIED_FOR_AGENTS, MAX_SUBAGENT_DEPTH, HookBlockedError } from './types.js';
import { clampInteractionMode } from './interactionModeClamp.js';
import { resolveEffectiveModel } from './resolveEffectiveModel.js';
import type { InteractionMode } from '../bootstrap/types.js';
import type { SharedContextAccess } from './types.js';
import type { SharedAgentContext } from './SharedAgentContext.js';
import { filterToolsByPatterns } from './toolFilter.js';
import { executeHooks, buildHookContext } from './hookExecutor.js';
import type { CustomCommandStore } from '../storage/CustomCommandStore.js';
import { createSkillTool } from '../tools/skillTool.js';
import { buildSkillsPromptSection } from '../core/skillsPrompt.js';
import { isReadOnlyTool } from '../config/toolSafety.js';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import type { AgentHistoryStore } from './AgentHistoryStore.js';

// Re-export ThoroughnessLevel for convenience
export type { ThoroughnessLevel };

/**
 * Callback invoked before agent.run() - use to subscribe to agent events
 */
export type BeforeRunCallback = (agent: ReActAgent, agentName: string) => void;

/**
 * Callback invoked after agent.run() - use to unsubscribe from agent events
 */
export type AfterRunCallback = (agent: ReActAgent, agentName: string) => void;

/**
 * Options for spawning an agent
 */
export interface SpawnAgentOptions {
  /** Task for the agent to perform */
  task: string;
  /** Agent name (e.g., 'explore', 'plan', 'code_review', or custom) */
  agentName: string;
  /** Thoroughness level (uses agent default if not specified) */
  thoroughness?: ThoroughnessLevel;
  /** Variables to substitute in system prompt */
  variables?: Record<string, string>;
  /** Parent session ID */
  parentSessionId: string;
  /**
   * Resume id to store this run's history under. When omitted, delegateToAgent
   * generates one. Background runs pass their job id so the resumable key matches
   * the id the model already sees.
   */
  resumeId?: string;
  /**
   * Prior conversation to replay into the agent (from a stored checkpoint) so a
   * resumed run continues with full context. See resume_agent.
   */
  previousMessages?: IMessage[];
  /** Override model for this execution (takes precedence over agent default) */
  model?: string;
  /** Additional tool restrictions (merged with agent definition) */
  allowedTools?: string[];
  /** LLM-provided description for grouped background notifications */
  groupDescription?: string;
  /** Inline agent definition (for dynamic agents - bypasses AgentStore lookup) */
  agentDefinition?: Omit<AgentDefinition, 'name' | 'source' | 'filePath'>;
  /** Optional abort signal to cancel execution and pending retries */
  abortSignal?: AbortSignal;
  /** Additional tools to inject after filtering (e.g., decompose_task for coordinator) */
  additionalTools?: ICompletionOptionTools[];
  /** Shared context for inter-agent communication within a pipeline */
  sharedContext?: SharedAgentContext;
  /**
   * Nesting depth of the agent being spawned (main agent = 0, its subagents = 1, ...).
   * Spawns at/above MAX_SUBAGENT_DEPTH are rejected. Defaults to 1 (a direct child
   * of the main agent) when a caller omits it.
   */
  depth?: number;
  /**
   * Parent agent's effective interaction mode - the ceiling the child cannot
   * exceed. Defaults to the live store mode (the main agent's mode) when omitted,
   * so direct children inherit the main agent's authority.
   */
  parentInteractionMode?: InteractionMode;
  /**
   * Interaction mode requested for the child. Clamped to parentInteractionMode,
   * so a request more permissive than the parent is capped. Defaults to inheriting
   * the parent's mode when omitted.
   */
  interactionMode?: InteractionMode;
  /**
   * Parent agent's effective model. A child with no explicit or agent-declared
   * model inherits this rather than silently defaulting to a different model.
   */
  parentModel?: string;
}

/**
 * Result from an agent execution
 */
export interface AgentExecutionResult extends AgentResult {
  /** Name of the agent that produced this result */
  agentName: string;
  /** Thoroughness level used */
  thoroughness: ThoroughnessLevel;
  /** Summary of the exploration/analysis (condensed for parent agent) */
  summary: string;
  /** Parent session ID this agent was spawned from */
  parentSessionId: string;
  /** Id under which this run's history was stored; pass to resume_agent to continue it. */
  resumeId: string;
}

/**
 * Dependencies required by the orchestrator
 */
export interface OrchestratorDependencies {
  userId: string;
  llm: ICompletionBackend;
  logger: Logger;
  permissionManager: PermissionManager;
  showPermissionPrompt: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>;
  configStore: any;
  apiClient: ApiClient;
  /** Agent store for loading agent definitions */
  agentStore: AgentStore;
  /** Optional: Custom command store for skill support in subagents */
  customCommandStore?: CustomCommandStore;
  /** Enable parallel execution of read-only tools for performance improvement */
  enableParallelToolExecution?: boolean;
  /** Callback for ask_user_question tool */
  showUserQuestion?: (payload: UserQuestionPayload) => Promise<UserQuestionResponse>;
  /** Optional: Checkpoint store for file change recovery */
  checkpointStore?: CheckpointStore | null;
  /** Optional: retains completed sub-agent conversations for resume_agent. */
  historyStore?: AgentHistoryStore | null;
}

/**
 * SubagentOrchestrator manages the lifecycle of specialized agents
 *
 * Responsibilities:
 * - Spawn agents with appropriate configurations from markdown files
 * - Manage context isolation
 * - Summarize results for parent agent
 * - Track agent execution metrics
 * - Execute lifecycle hooks
 */
export class SubagentOrchestrator {
  private deps: OrchestratorDependencies;
  private beforeRunCallback: BeforeRunCallback | null = null;
  private afterRunCallback: AfterRunCallback | null = null;

  constructor(deps: OrchestratorDependencies) {
    this.deps = deps;
  }

  /**
   * Set a callback to be invoked before each agent.run()
   * Use this to subscribe to agent events (e.g., agent.on('action', handler))
   */
  setBeforeRunCallback(callback: BeforeRunCallback | null): void {
    this.beforeRunCallback = callback;
  }

  /**
   * Set a callback to be invoked after each agent.run()
   * Use this to unsubscribe from agent events (e.g., agent.off('action', handler))
   */
  setAfterRunCallback(callback: AfterRunCallback | null): void {
    this.afterRunCallback = callback;
  }

  /**
   * Delegate a task to an agent loaded from markdown definition
   *
   * @param options - Configuration for agent execution
   * @returns Agent result with summary
   */
  async delegateToAgent(options: SpawnAgentOptions): Promise<AgentExecutionResult> {
    const { task, agentName, thoroughness, variables, parentSessionId, model, allowedTools, abortSignal } = options;

    // Recursion-depth cap (fail closed). A spawned agent is at least depth 1;
    // reject anything at/above the cap before doing any work.
    const depth = options.depth ?? 1;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Cannot spawn agent "${agentName}": subagent nesting depth ${depth} reached the limit ` +
          `of ${MAX_SUBAGENT_DEPTH}. Deeper delegation is blocked to prevent unbounded recursion.`
      );
    }

    // Id this run's history is stored under; background runs supply their job id.
    const resumeId = options.resumeId ?? `sub-${randomBytes(4).toString('hex')}`;

    // Clamp the child's interaction mode so it never runs more permissively than
    // its parent. The parent ceiling defaults to the live store mode (the main
    // agent's mode) for a direct child; nested spawns pass it explicitly.
    const { useCliStore } = await import('../store/index.js');
    const parentInteractionMode = options.parentInteractionMode ?? useCliStore.getState().interactionMode;
    const effectiveInteractionMode = clampInteractionMode(
      options.interactionMode ?? parentInteractionMode,
      parentInteractionMode
    );

    // Get agent definition: use inline definition if provided, otherwise look up from store
    let agentDef: AgentDefinition;
    if (options.agentDefinition) {
      agentDef = { ...options.agentDefinition, name: agentName, source: 'dynamic', filePath: '<dynamic>' };
    } else {
      const storedDef = this.deps.agentStore.getAgent(agentName);
      if (!storedDef) {
        const available = this.deps.agentStore.getAgentNames().join(', ');
        throw new Error(`Unknown agent: "${agentName}". Available agents: ${available}`);
      }
      agentDef = storedDef;
    }

    // Resolve the model through the explicit inherit path (see resolveEffectiveModel):
    // an unresolved agent inherits the parent's model - or the main session model -
    // rather than silently defaulting to a possibly-stronger model.
    const sessionDefaultModel =
      !model && !agentDef.modelResolved ? (await this.deps.configStore.get())?.defaultModel : undefined;
    const effectiveModel = resolveEffectiveModel({
      requestedModel: model,
      agentModel: agentDef.model,
      agentModelResolved: agentDef.modelResolved,
      parentModel: options.parentModel,
      sessionDefaultModel,
    });

    // Determine thoroughness (param > agent default > medium)
    const effectiveThoroughness = thoroughness || agentDef.defaultThoroughness;
    const maxIterations = agentDef.maxIterations[effectiveThoroughness];

    // Merge variables: passed > agent defaults
    const effectiveVariables = {
      ...agentDef.defaultVariables,
      ...variables,
    };

    // Substitute variables in system prompt (including reserved $MAX_ITERATIONS and $THOROUGHNESS)
    let systemPrompt = this.substituteVariables(agentDef.systemPrompt, task, effectiveVariables, {
      maxIterations,
      thoroughness: effectiveThoroughness,
    });

    // Determine effective allowed tools:
    // - If options.allowedTools provided, use it (skill-level restriction)
    // - Otherwise use agent definition's allowedTools
    const effectiveAllowedTools = allowedTools || agentDef.allowedTools;

    // Create tool filter from agent definition
    // IMPORTANT: Always deny agent_delegate to prevent chaining
    const toolFilter: ToolFilter = {
      allowedTools: effectiveAllowedTools,
      deniedTools: [...(agentDef.deniedTools || []), ...ALWAYS_DENIED_FOR_AGENTS],
    };

    // Generate tools and apply filter
    const agentContext: AgentContext = {
      currentAgent: null,
      observationQueue: [],
    };

    const { tools: allTools, agentContext: updatedContext } = await generateCliTools(
      this.deps.userId,
      this.deps.llm,
      effectiveModel,
      this.deps.permissionManager,
      this.deps.showPermissionPrompt,
      agentContext,
      this.deps.configStore,
      this.deps.apiClient,
      undefined, // toolFilter (applied below via filterToolsByPatterns)
      this.deps.showUserQuestion,
      this.deps.checkpointStore,
      undefined, // sandboxOrchestrator (not wired for subagents)
      undefined, // allowedDirectories (not wired for subagents)
      effectiveInteractionMode
    );

    // Apply wildcard filtering
    const filteredTools = filterToolsByPatterns(allTools, toolFilter.allowedTools, toolFilter.deniedTools);

    // Inject additional tools (e.g., decompose_task for coordinator agent)
    // Guard: never inject tools that are on the deny-list
    if (options.additionalTools) {
      const safe = options.additionalTools.filter(
        t => !(ALWAYS_DENIED_FOR_AGENTS as readonly string[]).includes(t.toolSchema.name)
      );
      filteredTools.push(...safe);
    }

    // Add skill tool for subagents if customCommandStore is available
    if (this.deps.customCommandStore) {
      const skillTool = createSkillTool({
        customCommandStore: this.deps.customCommandStore,
        subagentOrchestrator: this,
        sessionId: parentSessionId,
        allowedSkills: agentDef.skills,
        // This agent runs at `depth`; a skill it forks must spawn one level deeper.
        parentDepth: depth,
        // Onward forks inherit this agent's clamped mode as their ceiling.
        parentInteractionMode: effectiveInteractionMode,
        // Onward forks inherit this agent's model unless they declare their own.
        parentModel: effectiveModel,
      });
      filteredTools.push(skillTool);

      // Build skills section for system prompt with agent's restrictions
      const commands = this.deps.customCommandStore.getAllCommands();
      const skillsSection = buildSkillsPromptSection(commands, agentDef.skills);
      if (skillsSection) {
        systemPrompt += skillsSection;
      }
    }

    // Inject shared context tools if agent declares shared-context access
    if (options.sharedContext && agentDef.sharedContext?.length) {
      const sharedContextTools = this.buildSharedContextTools(options.sharedContext, agentDef.sharedContext, agentName);
      filteredTools.push(...sharedContextTools);
    }

    // Wrap tools with lifecycle hooks (PreToolUse, PostToolUse, PostToolUseFailure)
    const hookWrapperContext: HookWrapperContext = {
      sessionId: parentSessionId,
      agentName,
      cwd: process.cwd(),
    };

    const hookedTools = filteredTools.map(tool => wrapToolWithHooks(tool, agentDef.hooks, hookWrapperContext));

    this.deps.logger.debug(
      `Spawning "${agentName}" agent with ${hookedTools.length} tools, ` +
        `thoroughness: ${effectiveThoroughness}, max iterations: ${maxIterations}`
    );

    // Create agent instance with substituted prompt
    const agent = new ReActAgent({
      userId: this.deps.userId,
      logger: this.deps.logger,
      llm: this.deps.llm,
      model: effectiveModel,
      tools: hookedTools,
      maxIterations,
      systemPrompt,
    });

    // Link agent context
    updatedContext.currentAgent = agent;

    // Invoke beforeRunCallback to allow caller to subscribe to events
    if (this.beforeRunCallback) {
      this.beforeRunCallback(agent, agentName);
    }

    // Execute agent with retry for transient failures
    const startTime = Date.now();
    let result;
    try {
      const { result: agentResult, attempts } = await withRetry(
        () =>
          agent.run(task, {
            maxIterations,
            parallelExecution: this.deps.enableParallelToolExecution === true,
            isReadOnlyTool,
            maxHistoryIterations: 4,
            previousMessages: options.previousMessages,
          }),
        {
          maxRetries: agentDef.retry.maxRetries,
          initialDelayMs: agentDef.retry.initialDelayMs,
          isRetryable: isRetryableError,
          abortSignal,
          logger: {
            info: (msg, meta) => this.deps.logger.info(`[${agentName}] ${msg}`, meta),
            warn: (msg, meta) => this.deps.logger.warn(`[${agentName}] ${msg}`, meta),
          },
        }
      );
      if (attempts > 0) {
        this.deps.logger.info(`[${agentName}] Recovered after ${attempts} retry attempt${attempts === 1 ? '' : 's'}`);
      }
      result = agentResult;
    } catch (error) {
      if (error instanceof HookBlockedError) {
        // Agent blocked by hook - return gracefully
        if (this.afterRunCallback) {
          this.afterRunCallback(agent, agentName);
        }
        return {
          agentName,
          thoroughness: effectiveThoroughness,
          summary: `Agent blocked: ${error.message}`,
          parentSessionId,
          resumeId,
          finalAnswer: error.message,
          steps: [],
          completionInfo: {
            totalTokens: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 0,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        };
      }
      throw error;
    }
    const duration = Date.now() - startTime;

    // Execute Stop hooks
    if (agentDef.hooks?.Stop) {
      const stopResult = await executeHooks(
        agentDef.hooks.Stop,
        buildHookContext({
          ...hookWrapperContext,
          hookEventName: 'Stop',
        })
      );

      if (stopResult.decision === 'block') {
        this.deps.logger.debug(`Stop hook blocked: ${stopResult.reason}`);
        // Could implement continuation logic here
      }
    }

    // Invoke afterRunCallback to allow caller to unsubscribe from events
    if (this.afterRunCallback) {
      this.afterRunCallback(agent, agentName);
    }

    this.deps.logger.debug(
      `Agent "${agentName}" completed in ${duration}ms, ` +
        `${result.completionInfo.iterations} iterations, ${result.completionInfo.totalTokens} tokens`
    );

    // Generate summary
    const summary = this.summarizeResult(result, agentDef);

    // Persist the finished conversation so resume_agent can continue it.
    if (this.deps.historyStore) {
      const checkpoint = agent.toCheckpoint();
      // run() records the final answer as a step, not a message, so the agent's
      // own conclusion is absent from the checkpoint history. Append it as an
      // assistant turn so a resumed run sees what it previously concluded (the
      // whole point of "resume to fix the bug you found").
      const last = checkpoint.messages[checkpoint.messages.length - 1];
      if (result.finalAnswer && !(last?.role === 'assistant' && last.content === result.finalAnswer)) {
        checkpoint.messages.push({ role: 'assistant', content: result.finalAnswer });
      }
      this.deps.historyStore.set(resumeId, {
        checkpoint,
        agentName,
        agentDefinition: agentDef,
        thoroughness: effectiveThoroughness,
        parentSessionId,
        endTime: Date.now(),
      });
    }

    // Return agent result
    return {
      ...result,
      agentName,
      thoroughness: effectiveThoroughness,
      summary,
      parentSessionId,
      resumeId,
    };
  }

  /**
   * Build shared context tools based on agent's declared access permissions.
   */
  private buildSharedContextTools(
    sharedContext: SharedAgentContext,
    access: ReadonlyArray<SharedContextAccess>,
    agentName: string
  ): ICompletionOptionTools[] {
    const tools: ICompletionOptionTools[] = [];
    const canRead = access.includes('read');
    const canWrite = access.includes('write');

    if (canRead) {
      const ReadArgsSchema = z.object({
        namespace: z.string().min(1),
        key: z.string().optional(),
      });

      tools.push({
        toolFn: async (args: unknown) => {
          const { namespace, key } = ReadArgsSchema.parse(args);
          if (key) {
            const value = sharedContext.get(namespace, key);
            return value !== undefined
              ? `Value for "${key}" in namespace "${namespace}": ${value}`
              : `No entry found for "${key}" in namespace "${namespace}"`;
          }
          const all = sharedContext.getAll(namespace);
          const entries = Object.entries(all);
          if (entries.length === 0) {
            return `Namespace "${namespace}" is empty or does not exist.`;
          }
          return entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
        },
        toolSchema: {
          name: 'shared_context_read',
          description:
            'Read entries from the shared agent context. Use this to access findings from other agents in the pipeline.',
          parameters: {
            type: 'object',
            properties: {
              namespace: { type: 'string', description: 'Namespace to read from' },
              key: { type: 'string', description: 'Specific key to read (omit to list all entries in namespace)' },
            },
            required: ['namespace'],
          },
        },
      });
    }

    if (canWrite) {
      const WriteArgsSchema = z.object({
        namespace: z.string().min(1),
        key: z.string().min(1),
        value: z.string(),
      });

      tools.push({
        toolFn: async (args: unknown) => {
          const { namespace, key, value } = WriteArgsSchema.parse(args);
          sharedContext.set(namespace, key, value, agentName);
          return `Stored "${key}" in namespace "${namespace}"`;
        },
        toolSchema: {
          name: 'shared_context_write',
          description:
            'Write an entry to the shared agent context. Use this to share findings (file paths, insights, data) with other agents in the pipeline.',
          parameters: {
            type: 'object',
            properties: {
              namespace: { type: 'string', description: 'Namespace to write to' },
              key: { type: 'string', description: 'Key to store the value under' },
              value: { type: 'string', description: 'Value to store (max 2000 chars)' },
            },
            required: ['namespace', 'key', 'value'],
          },
        },
      });
    }

    return tools;
  }

  /**
   * Substitute variables in system prompt
   * Reserved: $TASK, $MAX_ITERATIONS, $THOROUGHNESS
   */
  private substituteVariables(
    systemPrompt: string,
    task: string,
    variables?: Record<string, string>,
    reserved?: { maxIterations: number; thoroughness: string }
  ): string {
    let result = systemPrompt;

    // Substitute $TASK with split/join (not regex) to avoid injection via
    // special replacement patterns ($&, $', $`, $1, etc.)
    result = result.split('$TASK').join(task);

    // Substitute reserved runtime variables
    if (reserved) {
      result = result.split('$MAX_ITERATIONS').join(String(reserved.maxIterations));
      result = result.split('$THOROUGHNESS').join(reserved.thoroughness);
    }

    // Substitute custom variables using literal string replacement
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        result = result.split(`$${key}`).join(value);
      }
    }

    return result;
  }

  /**
   * Summarize agent result for parent agent
   */
  private summarizeResult(result: AgentResult, agentDef: AgentDefinition): string {
    const { finalAnswer, steps, completionInfo } = result;

    // Count tool calls by type
    const toolCalls = steps.filter(s => s.type === 'action');
    const countByTool = (toolName: string): number => toolCalls.filter(s => s.metadata?.toolName === toolName).length;

    const filesRead = countByTool('file_read');
    const searches = countByTool('grep_search');
    const globs = countByTool('glob_files');

    // Build concise summary
    const capitalizedName = agentDef.name.charAt(0).toUpperCase() + agentDef.name.slice(1);
    const usage =
      completionInfo.totalCredits !== undefined
        ? `${completionInfo.totalTokens.toLocaleString()} tokens (${completionInfo.totalCredits.toLocaleString()} credits)`
        : `${completionInfo.totalTokens.toLocaleString()} tokens`;
    const lines = [
      `**${capitalizedName} Agent Results**\n`,
      `*${agentDef.description}*`,
      `*Execution: ${completionInfo.iterations} iterations, ${completionInfo.toolCalls} tool calls, ${usage}*\n`,
    ];

    // Add exploration stats if the agent used exploration tools
    if (filesRead > 0 || searches > 0 || globs > 0) {
      lines.push(`*Exploration: ${filesRead} files read, ${searches} searches, ${globs} glob patterns*\n`);
    }

    // Add final answer (truncate if too long)
    const maxLength = 1500;
    const truncatedAnswer =
      finalAnswer.length > maxLength ? finalAnswer.slice(0, maxLength) + '\n\n...(truncated)' : finalAnswer;
    lines.push(truncatedAnswer);

    return lines.join('\n');
  }

  /**
   * Get available agent names (for autocomplete/validation)
   */
  getAvailableAgents(): string[] {
    return this.deps.agentStore.getAgentNames();
  }

  /**
   * Check if an agent exists
   */
  hasAgent(name: string): boolean {
    return this.deps.agentStore.hasAgent(name);
  }
}
