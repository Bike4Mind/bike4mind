import {
  DecomposeTaskInputSchema,
  validateAndSort,
  type DecomposedTask,
  type DecomposeTaskInput,
  type ThoroughnessLevel,
} from '@bike4mind/agents';
import type { Logger } from '@bike4mind/observability';
import type { ICompletionBackend, ICompletionOptionTools, ApiKeyTable } from '@bike4mind/llm-adapters';
import { getLlmByModel } from '@bike4mind/llm-adapters';
import type { ModelInfo } from '@bike4mind/common';
import { ServerSubagentOrchestrator } from '../../agents/ServerSubagentOrchestrator';
import type { ServerSubagentTracker, SubagentHandoffSignal } from '../../agents/ServerSubagentOrchestrator';
import { ServerAgentStore } from '../../agents/ServerAgentStore';

/**
 * Maximum number of nodes the coordinator is allowed to emit in a single DAG.
 * Typical useful decompositions are 2-8 nodes; >20 is almost certainly a
 * model regression and would flood the dispatch queue + cap-counting query.
 */
const MAX_DAG_NODES = 20;

/**
 * Parameters for the coordinate_task tool.
 */
interface CoordinateTaskParams {
  task: string;
  thoroughness?: ThoroughnessLevel;
}

/**
 * Signal the executor reads after each iteration to detect that the parent
 * agent has handed off to a DAG of children and should transition to
 * `awaiting_dag_children`. Mirrors the `SubagentHandoffSignal` shape so the
 * executor's post-iteration check can stay simple. The executor recovers the
 * `coordinate_task` tool_use id from `agent.getLatestToolCallId(...)` (same
 * pattern as `delegate_to_agent`).
 */
export interface DagHandoffSignal {
  awaitingDagChildren?: {
    /** The full decomposition - executor persists this on the parent doc. */
    spec: DecomposeTaskInput;
    /** dagNodeId values for children created but not yet terminal. */
    pendingNodeIds: string[];
  };
}

/**
 * Per-child handle the dispatcher returns. Mirrors the shape the orchestrator's
 * tracker `onStart` produces - opaque to the tool, used by the executor to
 * locate the corresponding child doc.
 */
export interface DagNodeHandle {
  /** The persisted AgentExecutionDoc id for this DAG node. */
  childExecutionId: string;
  /** The dagNodeId from the decomposition (e.g. "explore-auth"). */
  dagNodeId: string;
}

/**
 * Dispatcher abstraction the tool uses to materialise a DAG into persisted
 * child executions and dispatch the root nodes. The web executor implements
 * this; the tool stays decoupled from SQS, MongoDB, and the Lambda runtime.
 */
export interface DagDispatcher {
  /**
   * Create a child AgentExecutionDoc for a single DAG node in `pending` status.
   * The dispatched Lambda will CAS-claim it via `claimExecution`. Returns the
   * persisted child execution id so the dispatcher can later dispatch it (or
   * skip if blocked).
   */
  createNode(input: {
    parentExecutionId: string;
    node: DecomposedTask;
    /** Per-node thoroughness (defaults to the parent's coordinate_task call). */
    thoroughness: ThoroughnessLevel;
    /** The agent definition the node will run as. */
    agentName: string;
    /**
     * The model id to run this node with. Should be the agent definition's
     * `model` (or a sensible fallback) - NOT the parent execution's session
     * model, which may not be available as a Bedrock inference profile.
     * Matches how `ServerSubagentOrchestrator.dispatchAndPollSubagent`
     * resolves `effectiveModel = agentDef.model || parent.llm.currentModel`.
     */
    model: string;
    /**
     * The per-thoroughness iteration cap resolved from the agent definition
     * (`agentDef.maxIterations[thoroughness]`). Snapshotted onto the child doc
     * so the dispatched Lambda's `subagent_started` WS event reports the
     * actual cap the orchestrator will enforce.
     */
    maxIterations: number;
  }): Promise<DagNodeHandle>;

  /**
   * Dispatch a single ready node to its own Lambda via SQS. Idempotent: the
   * dispatched Lambda CAS-claims `pending -> running` so a duplicate enqueue is
   * a no-op.
   */
  dispatchNode(input: { childExecutionId: string; dagNodeId: string }): Promise<void>;
}

/**
 * The web tool's `coordinate_task` invocation needs a tool_use id so the
 * resume path can surgically replace the placeholder observation in the
 * parent's message history. The ReActAgent loop assigns this id; we receive
 * it via a getter (same pattern as `getSignal`/`handoffSignal` in delegate_to_agent).
 */
export interface CoordinateTaskToolDeps {
  userId: string;
  llm: ICompletionBackend;
  logger: Logger;
  parentTools: ICompletionOptionTools[];
  getSignal?: () => AbortSignal | undefined;
  availableModels?: ModelInfo[];
  onStatusUpdate?: (status: string) => Promise<void>;
  thinking?: { enabled: boolean; budget_tokens: number };
  agentStore: ServerAgentStore;
  apiKeyTable?: ApiKeyTable;
  /**
   * Tracker used for the coordinator agent's own (in-process) execution.
   * Not used for DAG children - those go through `dagDispatcher`.
   */
  tracker?: ServerSubagentTracker;
  /**
   * Reused for the coordinator's in-process subagent run (which will not
   * dispatch to its own Lambda because the coordinator is short-lived).
   */
  getRemainingTimeMs?: () => number;
  subagentHandoffSignal?: SubagentHandoffSignal;

  /**
   * Materialises and dispatches DAG children. Provided by the executor; absent
   * when no execution context (e.g. ChatCompletionProcess) - in that case the
   * tool is omitted entirely from the tool list.
   */
  dagDispatcher: DagDispatcher;

  /**
   * The current execution id (the parent that's calling `coordinate_task`).
   * Passed by closure from the executor at tool-build time.
   */
  getParentExecutionId: () => string;

  /**
   * Mutable side-channel the tool populates when it wants the executor to
   * transition the parent to `awaiting_dag_children` after this iteration.
   * Mirrors the existing `SubagentHandoffSignal` pattern (don't throw -
   * `ReActAgent.executeToolWithQueueFallback` swallows tool errors and
   * converts them to observation strings).
   */
  dagHandoffSignal?: DagHandoffSignal;
}

/**
 * Create the `coordinate_task` tool.
 *
 * Flow:
 *  1. Spawn the `coordinator` agent in-process via `ServerSubagentOrchestrator`.
 *     The coordinator's only structured output is via the `decompose_task` tool;
 *     we inject a capturing instance into its tool list.
 *  2. Validate the captured DAG via shared `validateAndSort` (cycles, duplicates,
 *     unknown deps all throw with structured messages).
 *  3. If the decomposition is single-task, fall through to a single
 *     `delegate_to_agent`-style execution (no DAG overhead).
 *  4. Otherwise: persist `dagSpec` on the parent, create N child docs, dispatch
 *     all root nodes (`dependsOn: []`), populate `dagHandoffSignal` so the
 *     executor knows to set `awaiting_dag_children` after this iteration, and
 *     return a placeholder observation that the resume path will replace.
 */
export function createCoordinateTaskTool(deps: CoordinateTaskToolDeps): ICompletionOptionTools {
  const { agentStore } = deps;

  return {
    toolFn: async (args: unknown) => {
      const params = args as CoordinateTaskParams;

      if (!params.task) {
        return 'Error: coordinate_task requires a "task" parameter describing the overall goal.';
      }

      const coordinator = agentStore.getAgent('coordinator');
      if (!coordinator) {
        return 'Error: the coordinator agent is not available in this environment. Falling back to direct delegation is recommended for now.';
      }

      const parentExecutionId = deps.getParentExecutionId();

      await deps.onStatusUpdate?.('Decomposing the task…');

      // -- Spawn the coordinator with a decompose_task capture tool --
      const capture: { result: DecomposeTaskInput | null } = { result: null };
      const decomposeTool = createDecomposeTaskCaptureTool(capture);

      const orchestrator = new ServerSubagentOrchestrator({
        userId: deps.userId,
        llm: deps.llm,
        logger: deps.logger,
        // Coordinator only needs read tools (it's denied write tools at the
        // agent-definition level) - we pass the parent's tool list and the
        // agent's allowedTools/deniedTools filter the rest.
        parentTools: [...deps.parentTools, decomposeTool],
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
        tracker: deps.tracker,
        getRemainingTimeMs: deps.getRemainingTimeMs,
        handoffSignal: deps.subagentHandoffSignal,
      });

      try {
        await orchestrator.delegateToAgent({
          task: params.task,
          agentDef: coordinator,
          thoroughness: params.thoroughness,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.logger.error('[coordinate_task] coordinator agent failed', { error: msg });
        return `Error: the coordinator agent failed to produce a decomposition: ${msg}. Consider calling delegate_to_agent directly with a single specialized agent.`;
      }

      if (!capture.result) {
        return 'The coordinator did not produce a task decomposition. Falling back to direct delegation is recommended — call delegate_to_agent with the right agent for this task.';
      }

      // -- Validate the DAG --
      let executionLevels: string[][];
      try {
        executionLevels = validateAndSort(capture.result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.logger.warn('[coordinate_task] DAG validation failed', { error: msg });
        return `The coordinator produced an invalid decomposition: ${msg}. Try a simpler delegate_to_agent call instead.`;
      }

      // Defense-in-depth: reject DAGs over MAX_DAG_NODES nodes to prevent
      // runaway fan-out from a pathological coordinator response. A typical
      // useful decomposition is 2-8 nodes; anything over 20 is almost
      // certainly a model regression and would flood SQS + the cap query.
      if (capture.result.tasks.length > MAX_DAG_NODES) {
        deps.logger.warn('[coordinate_task] DAG exceeded max node count', {
          nodeCount: capture.result.tasks.length,
          limit: MAX_DAG_NODES,
        });
        return `The coordinator produced a ${capture.result.tasks.length}-node DAG, which exceeds the ${MAX_DAG_NODES}-node limit for a single coordinate_task call. Break the task into smaller phases and call coordinate_task on each phase, or use delegate_to_agent for individual subtasks.`;
      }

      const spec = capture.result;

      // -- Create children --
      // We intentionally don't persist the DAG spec on the parent here; the
      // executor does that after the iteration via `getLatestToolCallId` so
      // the persisted spec is paired with the right tool_use id for resume.
      const handles: DagNodeHandle[] = [];
      const thoroughness: ThoroughnessLevel = params.thoroughness ?? 'medium';
      // v1 tradeoff: child docs are created sequentially. For the expected
      // common case (single-digit DAGs) the latency is dominated by the LLM
      // decomposition pass that already ran. For DAGs near MAX_DAG_NODES
      // (20), this is up to 20 serial MongoDB round-trips before the first
      // root dispatches - switch to a batched insert (or Promise.all over
      // createNode) if profiling shows it matters.
      for (const node of spec.tasks) {
        const agentName = mapAgentTypeToWebAgent(node.agentType);
        if (!agentStore.hasAgent(agentName)) {
          deps.logger.warn('[coordinate_task] unknown agent for node — using researcher fallback', {
            requested: agentName,
            dagNodeId: node.id,
          });
        }
        const resolvedAgentName = agentStore.hasAgent(agentName) ? agentName : 'researcher';
        // Use the agent's preferred model - matches how `delegate_to_agent`
        // resolves `effectiveModel`. Falls back to the parent's LLM model
        // only if the agent has no preference. The agent's model is far
        // more likely to be a valid Bedrock inference profile than the
        // user's session model (which can be a UI shortcut not provisioned
        // in every stage).
        const agentDef = agentStore.getAgent(resolvedAgentName);
        const agentModel = agentDef?.model ?? deps.llm.currentModel;
        // Resolve the iteration cap from the agent def so the snapshot stored
        // on the child doc matches what `delegateToAgent` will enforce at run
        // time. Fall back to a safe default if the agent has no profile (the
        // researcher fallback above always has one in practice).
        const agentMaxIterations = agentDef?.maxIterations?.[thoroughness] ?? 8;
        const handle = await deps.dagDispatcher.createNode({
          parentExecutionId,
          node,
          thoroughness,
          agentName: resolvedAgentName,
          model: agentModel,
          maxIterations: agentMaxIterations,
        });
        handles.push(handle);
      }

      // -- Dispatch all root nodes (dependsOn empty) --
      const handleByNodeId = new Map(handles.map(h => [h.dagNodeId, h]));
      const rootNodes = spec.tasks.filter(t => t.dependsOn.length === 0);
      for (const root of rootNodes) {
        const handle = handleByNodeId.get(root.id);
        if (!handle) continue;
        await deps.dagDispatcher.dispatchNode({
          childExecutionId: handle.childExecutionId,
          dagNodeId: handle.dagNodeId,
        });
      }

      // -- Signal the executor to transition parent to awaiting_dag_children --
      if (deps.dagHandoffSignal) {
        deps.dagHandoffSignal.awaitingDagChildren = {
          spec,
          pendingNodeIds: spec.tasks.map(t => t.id),
        };
      }

      const taskList = spec.tasks
        .map(t => {
          const deps = t.dependsOn.length ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
          return `- [${t.agentType}] ${t.id}: ${t.description}${deps}`;
        })
        .join('\n');

      // Placeholder observation. The executor's `resumeAfterDagChildren` path
      // will surgically replace this with the aggregated DAG report before the
      // parent agent's next iteration sees it.
      return `Decomposed the task into ${spec.tasks.length} subtasks across ${executionLevels.length} dependency level(s). Dispatching ${rootNodes.length} root node(s) to parallel Lambda invocations now.\n\nDecomposition:\n${taskList}\n\nThe DAG will execute in parallel; the synthesized result will be available in the next iteration.`;
    },
    toolSchema: {
      name: 'coordinate_task',
      description: `Decompose a complex multi-part task into a DAG and execute its nodes in parallel across separate Lambda invocations. **Strongly prefer this over chaining multiple \`delegate_to_agent\` calls when the work has any parallelism.**

**Use \`coordinate_task\` when:**
- The user's request contains "in parallel", "concurrently", "research X and Y", "compare A vs B", or any pattern where 2+ pieces of work could happen at the same time
- You would otherwise need 2+ sequential \`delegate_to_agent\` calls to specialised agents
- The work has a dependency shape (research → analyse → synthesise; or fan-out → aggregate)

**Why prefer it over \`delegate_to_agent\` × N:**
- Independent nodes run truly in parallel (separate Lambdas), not sequentially — wall-clock time drops linearly with parallelism
- The DAG result comes back as a single synthesised markdown report on your next iteration — no manual stitching of multiple \`delegate_to_agent\` results
- Per-node failure policy (\`cascade\` vs \`isolate\`) lets one branch fail without poisoning the whole synthesis
- Dependent nodes are sequenced after their blockers complete; the aggregated results of all nodes are synthesized into the report you receive on resume (dependent nodes do NOT currently get the blocker's output as in-context input — they run on their own \`description\` only)

**Do NOT use** for genuinely single-step tasks where one specialised agent suffices. The coordinator's decomposition pass (one Opus call) is overhead that only pays off on tasks with ≥ 2 parallelisable units of work.

**Flow:** the coordinator (Opus) reads your task, emits a structured DAG (typically 2–8 nodes), the executor dispatches roots to parallel Lambdas, each dependent waits for its blockers, and you receive an aggregated markdown report when the graph completes. Your job after receiving it is to write the final user-facing answer using the report as raw material.`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The full overall task to decompose. Be specific about what the user wants as the end result.',
          },
          thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'very_thorough'],
            description:
              'Per-node thoroughness applied to every DAG child. Defaults to medium. Use quick for cheap fan-out research; very_thorough for analyses each child needs to be deep.',
          },
        },
        required: ['task'],
      },
    },
  };
}

/**
 * Build the `decompose_task` capture tool that's injected into the coordinator
 * agent's tool list. The coordinator MUST call this exactly once with the DAG;
 * the tool validates via the shared Zod schema, dedupes, and stores the result
 * in the provided capture object for the outer `coordinate_task` flow.
 */
function createDecomposeTaskCaptureTool(capture: { result: DecomposeTaskInput | null }): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      if (capture.result !== null) {
        return 'Task decomposition already accepted. Do not call decompose_task again.';
      }

      const parsed = DecomposeTaskInputSchema.safeParse(args);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid task decomposition:\n${errors}`);
      }

      const ids = parsed.data.tasks.map(t => t.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate task IDs: ${[...new Set(duplicates)].join(', ')}`);
      }

      capture.result = parsed.data;

      const taskSummary = parsed.data.tasks
        .map(t => {
          const dep = t.dependsOn.length ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
          const policy = t.onFailure !== 'cascade' ? ` [onFailure: ${t.onFailure}]` : '';
          return `- [${t.agentType}] ${t.id}: ${t.description}${dep}${policy}`;
        })
        .join('\n');

      return `Task decomposition accepted (${parsed.data.tasks.length} tasks):\n${taskSummary}`;
    },
    toolSchema: {
      name: 'decompose_task',
      description: `Decompose the user's task into a DAG of subtasks. Each subtask has:
- **id**: unique identifier (e.g. "explore-auth")
- **description**: clear, self-contained description of the work
- **agentType**: which specialised agent should execute it (explore, plan, general-purpose, review, test)
- **dependsOn**: ids of subtasks that must complete first (default: [])
- **onFailure**: 'cascade' (default — dependents are skipped if this fails) or 'isolate' (dependents proceed without this result)

Independent subtasks run in parallel across separate Lambda invocations. You MUST call this exactly once.`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Array of subtasks forming a dependency DAG',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique node id' },
                description: { type: 'string', description: 'What this subtask should accomplish' },
                agentType: {
                  type: 'string',
                  enum: ['explore', 'plan', 'general-purpose', 'review', 'test'],
                  description: 'Specialised agent type for this node',
                },
                dependsOn: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Node ids that must complete first',
                },
                onFailure: {
                  type: 'string',
                  enum: ['cascade', 'isolate'],
                  description:
                    "Failure policy: cascade (dependents skipped) or isolate (dependents proceed). Default 'cascade'.",
                },
              },
              required: ['id', 'description', 'agentType'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  };
}

/**
 * The DAG schema's `agentType` field uses the CLI's vocabulary
 * (explore/plan/general-purpose/review/test). Map those to the web's
 * `ServerAgentStore` agent names so we dispatch to an agent that actually
 * exists on this surface.
 */
function mapAgentTypeToWebAgent(agentType: DecomposedTask['agentType']): string {
  switch (agentType) {
    case 'explore':
      return 'researcher';
    case 'plan':
      return 'analyst';
    case 'review':
      return 'code_review';
    case 'test':
      // No dedicated test agent on the web yet - fall back to analyst.
      return 'analyst';
    case 'general-purpose':
    default:
      return 'researcher';
  }
}
