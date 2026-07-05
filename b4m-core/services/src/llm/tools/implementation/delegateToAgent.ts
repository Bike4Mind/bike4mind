import type { ApiKeyTable, ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { ThoroughnessLevel } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import { ServerSubagentOrchestrator } from '../../agents/ServerSubagentOrchestrator';
import type { ServerSubagentTracker, SubagentHandoffSignal } from '../../agents/ServerSubagentOrchestrator';
import { ServerAgentStore } from '../../agents/ServerAgentStore';

/**
 * Parameters for the delegate_to_agent tool
 */
interface DelegateToAgentParams {
  task: string;
  agent: string;
  thoroughness?: ThoroughnessLevel;
  variables?: Record<string, string>;
  attachedFiles?: Array<{ fabFileId: string; filename: string; mimeType?: string }>;
  /**
   * When true, the orchestrator dispatches the subagent to its own Lambda and the
   * tool returns immediately with a structured `{ status: 'background_started', ... }`
   * payload. The LLM should treat this as a fire-and-forget - the parent does not
   * wait for the subagent to finish.
   */
  background?: boolean;
}

/**
 * Telemetry data for a subagent execution
 */
export interface SubagentTelemetryData {
  agentName: string;
  durationMs: number;
  totalTokensUsed: number;
  iterations: number;
  toolCalls: number;
  credits: number;
  success: boolean;
  isTimeout: boolean;
  thoroughness?: ThoroughnessLevel;
  error?: string;
}

/**
 * Dependencies for creating the delegate_to_agent tool
 */
export interface DelegateToAgentToolDeps {
  userId: string;
  llm: ICompletionBackend;
  logger: Logger;
  /** All parent tools (the subagent will receive a filtered subset) */
  parentTools: ICompletionOptionTools[];
  /**
   * Getter for the parent's abort signal. Uses a getter because the AbortController
   * is created after buildTools() returns - the signal isn't available at tool
   * construction time but will be available when the tool is actually invoked.
   */
  getSignal?: () => AbortSignal | undefined;
  /** Callback to report credits used by the agent delegation */
  onCredits?: (credits: number) => void;
  /** Available models for credit computation */
  availableModels?: ModelInfo[];
  /** Callback to send status updates to the client during subagent execution */
  onStatusUpdate?: (status: string) => Promise<void>;
  /** Callback to report subagent telemetry data */
  onTelemetry?: (telemetry: SubagentTelemetryData) => void;
  /** Extended thinking configuration to propagate to subagents */
  thinking?: { enabled: boolean; budget_tokens: number };
  /** Per-request agent store with user-specific configs baked in */
  agentStore: ServerAgentStore;
  /** API key table for resolving fresh backends when agent model differs from parent */
  apiKeyTable?: ApiKeyTable;
  /**
   * Optional lifecycle tracker for persisting child AgentExecutionDocs (Phase 2).
   * Used by the Agent Executor Lambda; ChatCompletionProcess leaves this undefined
   * so subagents stay purely in-process.
   */
  tracker?: ServerSubagentTracker;
  /**
   * Returns the parent Lambda's remaining wall-clock time. When provided, the
   * orchestrator decides whether to run subagents in-process or dispatch them to
   * their own Lambda. Required for the synchronous Lambda-dispatch + handoff path.
   */
  getRemainingTimeMs?: () => number;
  /**
   * Mutable side-channel ref the orchestrator populates when the parent runs out of
   * time mid-poll on a sync Lambda-dispatched child. The executor reads this AFTER
   * `runIteration()` returns and persists `awaiting_subagent` state if set.
   */
  handoffSignal?: SubagentHandoffSignal;
  /**
   * Delegation depth of the agent invoking this tool. The child orchestrator
   * is created with depth + 1 so it can enforce the MAX_SUBAGENT_DEPTH cap on
   * further nesting. Omitted by sharedToolBuilder (undefined -> treated as 0),
   * so the first child gets depth 1, the second depth 2, and the third
   * depth 3 = MAX_SUBAGENT_DEPTH where the cap fires.
   */
  depth?: number;
  /**
   * Lazy getter that returns the execution id of the agent that owns this tool
   * instance. Populated after `tracker.onStart` resolves for the parent
   * orchestrator - undefined at tool-creation time, non-null by the time the
   * tool is invoked. Used to stamp `parentExecutionId` on grandchild tracker
   * events so they route to the correct node in the client store.
   */
  getParentExecutionId?: () => string | undefined;
}

/**
 * Create the delegate_to_agent tool.
 *
 * This tool allows the LLM to spawn specialized subagents registered in the ServerAgentStore
 * that run autonomously using a ReActAgent loop and return summarized results.
 *
 * The tool is constructed AFTER all other tools are built, receiving the parent's
 * complete tool list. The subagent gets a filtered subset (with delegate_to_agent
 * itself always excluded to prevent recursive delegation).
 */
export function createDelegateToAgentTool(deps: DelegateToAgentToolDeps): ICompletionOptionTools {
  const { agentStore } = deps;
  const agentDescriptions = agentStore
    .getAllAgents()
    .map(a => `- **${a.name}**: ${a.description}`)
    .join('\n');
  const agentNames = agentStore.getAgentNames();

  const reportValidationFailure = (params: DelegateToAgentParams, startTime: number, error: string): void => {
    if (!deps.onTelemetry) return;
    deps.onTelemetry({
      agentName: params.agent || 'unknown',
      durationMs: Date.now() - startTime,
      totalTokensUsed: 0,
      iterations: 0,
      toolCalls: 0,
      credits: 0,
      success: false,
      isTimeout: false,
      thoroughness: params.thoroughness,
      error,
    });
  };

  return {
    toolFn: async (args: unknown) => {
      const params = args as DelegateToAgentParams;
      const startTime = Date.now();

      if (!params.task) {
        reportValidationFailure(params, startTime, 'missing required param: task');
        return 'Error: delegate_to_agent requires a "task" parameter describing what the agent should do. Please retry with a task.';
      }

      if (!params.agent) {
        reportValidationFailure(params, startTime, 'missing required param: agent');
        return `Error: delegate_to_agent requires an "agent" parameter. Available agents: ${agentNames.join(', ')}`;
      }

      const agentDef = agentStore.getAgent(params.agent);
      if (!agentDef) {
        const available = agentNames.join(', ');
        reportValidationFailure(params, startTime, `unknown agent: ${params.agent}`);
        return `Error: unknown agent "${params.agent}". Available agents: ${available}`;
      }

      // Notify the client that the subagent is starting
      await deps.onStatusUpdate?.('Starting...');

      // sharedToolBuilder creates the initial delegate tool with no `depth` set
      // (undefined). Treating that as 0 makes the first child depth=1, the
      // second depth=2, and the third depth=3=MAX (where the cap fires). The
      // old default of ?? 1 made the first child depth=2, leaving only one
      // level of delegation before the cap - breaking the 3-hop chain.
      const childDepth = (deps.depth ?? 0) + 1;

      // Capture the child's execution id after tracker.onStart resolves so the
      // grandchild delegate tool can stamp it as parentExecutionId on its own
      // tracker calls. The ref is undefined at tool-creation time but is
      // always populated before any grandchild tool invocation runs.
      let capturedChildId: string | undefined;
      const trackerForChild: typeof deps.tracker = deps.tracker
        ? {
            ...deps.tracker,
            onStart: async info => {
              const id = await deps.tracker!.onStart({
                ...info,
                // Preserve parentExecutionId injected by a deeper wrapper (e.g.
                // trackerForLeaf at depth=2) before falling back to our own
                // captured child id. Without the ?? guard, depth-1 always wins
                // and overwrites the Sub->Leaf parentExecutionId stamped by
                // trackerForChild.
                parentExecutionId: info.parentExecutionId ?? deps.getParentExecutionId?.(),
              });
              capturedChildId = id;
              return id;
            },
          }
        : undefined;

      // parentTools is captured in sharedToolBuilder BEFORE the delegate tool
      // is pushed onto the final tools array, so deps.parentTools never contains
      // delegate_to_agent. Append a fresh depth-stamped instance rather than
      // trying to replace a nonexistent entry via .map().
      const parentToolsForChild = [
        ...deps.parentTools,
        createDelegateToAgentTool({
          ...deps,
          depth: childDepth,
          tracker: trackerForChild,
          getParentExecutionId: () => capturedChildId,
        }),
      ];

      const orchestrator = new ServerSubagentOrchestrator({
        userId: deps.userId,
        llm: deps.llm,
        logger: deps.logger,
        parentTools: parentToolsForChild,
        signal: deps.getSignal?.(),
        availableModels: deps.availableModels,
        onProgress: deps.onStatusUpdate,
        thinking: deps.thinking,
        resolveBackend: deps.apiKeyTable
          ? (modelId: string) => {
              const modelInfo = deps.availableModels?.find(m => m.id === modelId);
              return modelInfo
                ? getLlmByModel(deps.apiKeyTable!, { modelInfo, logger: deps.logger, endUserId: deps.userId })
                : null;
            }
          : undefined,
        tracker: trackerForChild,
        getRemainingTimeMs: deps.getRemainingTimeMs,
        handoffSignal: deps.handoffSignal,
        depth: childDepth,
      });

      // Background mode: dispatch + return a structured payload immediately. The LLM
      // sees the childExecutionId as the tool result and the parent's iteration loop
      // continues. The dispatched child will stream `subagent_*` events to the parent's
      // WebSocket and emit `subagent_completed` when done.
      //
      // Guard: background dispatch requires a tracker with onStart + onLambdaDispatch.
      // When running inside ChatCompletionProcess (no tracker), fall back to synchronous
      // foreground execution so the LLM still gets a result instead of an error.
      if (params.background && deps.tracker?.onStart && deps.tracker?.onLambdaDispatch) {
        try {
          const dispatch = await orchestrator.dispatchBackgroundAgent({
            task: params.task,
            agentDef,
            thoroughness: params.thoroughness,
            variables: params.variables,
            attachedFiles: params.attachedFiles,
          });
          const durationMs = Date.now() - startTime;
          if (deps.onTelemetry) {
            deps.onTelemetry({
              agentName: dispatch.agentName,
              durationMs,
              totalTokensUsed: 0,
              iterations: 0,
              toolCalls: 0,
              credits: 0,
              success: true,
              isTimeout: false,
              thoroughness: dispatch.thoroughness,
            });
          }
          return JSON.stringify({
            status: 'background_started',
            childExecutionId: dispatch.childExecutionId,
            agentName: dispatch.agentName,
            thoroughness: dispatch.thoroughness,
            message: `Subagent "${dispatch.agentName}" started in the background. Results will arrive asynchronously via the subagent_completed event (childExecutionId: ${dispatch.childExecutionId}).`,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (deps.onTelemetry) {
            deps.onTelemetry({
              agentName: params.agent,
              durationMs: Date.now() - startTime,
              totalTokensUsed: 0,
              iterations: 0,
              toolCalls: 0,
              credits: 0,
              success: false,
              isTimeout: false,
              thoroughness: params.thoroughness,
              error: errorMessage.substring(0, 200),
            });
          }
          throw error;
        }
      }

      try {
        const result = await orchestrator.delegateToAgent({
          task: params.task,
          agentDef,
          thoroughness: params.thoroughness,
          variables: params.variables,
          attachedFiles: params.attachedFiles,
        });

        const durationMs = Date.now() - startTime;

        if (result.completionInfo.totalCredits && deps.onCredits) {
          deps.onCredits(result.completionInfo.totalCredits);
        }

        // Report telemetry for successful execution
        if (deps.onTelemetry) {
          deps.onTelemetry({
            agentName: result.agentName,
            durationMs,
            totalTokensUsed: result.completionInfo.totalTokens ?? 0,
            iterations: result.completionInfo.iterations ?? 0,
            toolCalls: result.completionInfo.toolCalls ?? 0,
            credits: result.completionInfo.totalCredits ?? 0,
            success: true,
            isTimeout: false,
            thoroughness: result.thoroughness,
          });
        }

        return result.summary;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimeout =
          errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('aborted');

        // Report telemetry for failed execution
        if (deps.onTelemetry) {
          deps.onTelemetry({
            agentName: params.agent,
            durationMs,
            totalTokensUsed: 0,
            iterations: 0,
            toolCalls: 0,
            credits: 0,
            success: false,
            isTimeout,
            thoroughness: params.thoroughness,
            error: errorMessage.substring(0, 200),
          });
        }

        throw error;
      }
    },
    toolSchema: {
      name: 'delegate_to_agent',
      description: `Delegate a task to a specialized agent that runs autonomously with its own tools and reasoning loop.

**Available Agents:**
${agentDescriptions}

**Benefits:**
- Agents run autonomously with multiple iterations of reasoning and tool use
- They use specialized prompts optimized for each task type
- Results are summarized concisely for you

**IMPORTANT: Write operations (GitHub, Jira, Confluence) have built-in confirmation buttons.**
Do NOT ask the user for confirmation before delegating — just delegate immediately. The tools themselves show Confirm/Cancel buttons to the user before executing any write operation. Asking for text confirmation defeats this mechanism.

**File uploads:** When the conversation includes attached files (fabFileId context), always pass them via the \`attachedFiles\` parameter with the exact fabFileId and filename. Do not rename files or use URLs — pass fabFileId only.`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'Clear description of what the agent should do. Be specific about what information to find or what to analyze.',
          },
          agent: {
            type: 'string',
            enum: agentNames,
            description: `Name of the agent to use. Available: ${agentNames.join(', ')}`,
          },
          thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'very_thorough'],
            description: `How thoroughly to execute:
- quick: Fast lookup, 2-3 iterations
- medium: Balanced exploration, 5-8 iterations (default)
- very_thorough: Comprehensive analysis, 10-15 iterations`,
          },
          variables: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Custom variables to substitute in agent system prompt (e.g., { "DOMAIN": "authentication" })',
          },
          attachedFiles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fabFileId: { type: 'string', description: 'The fabFileId from the file context' },
                filename: { type: 'string', description: 'The exact filename from the file context' },
                mimeType: { type: 'string', description: 'MIME type of the file' },
              },
              required: ['fabFileId', 'filename'],
            },
            description:
              'Files attached to the conversation. IMPORTANT: Copy the exact fabFileId and filename from the [ATTACHED FILES] context — do not rename or invent filenames.',
          },
          background: {
            type: 'boolean',
            description:
              'If true, run this subagent in background mode: it dispatches to its own Lambda invocation and the tool returns immediately with a structured childExecutionId payload. The actual subagent result arrives asynchronously via the subagent_completed event. Use for long-running background tasks you do not need to await before continuing.',
          },
        },
        required: ['task', 'agent'],
      },
    },
  };
}
