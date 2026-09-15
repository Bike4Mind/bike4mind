import { z } from 'zod';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { SubagentOrchestrator } from './SubagentOrchestrator.js';
import type { AgentStore } from './AgentStore.js';
import { createDecomposeTaskTool, type DecompositionCapture } from './decomposeTaskTool.js';
import { TaskPipeline, type DecomposedTask } from './TaskPipeline.js';
import { SharedAgentContext } from './SharedAgentContext.js';

/**
 * Zod schema for coordinate_task tool parameters
 */
const CoordinateTaskParamsSchema = z.object({
  task: z.string().min(1, 'Task description is required'),
  thoroughness: z.enum(['quick', 'medium', 'very_thorough']).optional().default('medium'),
});

/** Truncation limits for context passed between pipeline tasks */
const MAX_DEPENDENCY_CONTEXT_LENGTH = 1500;

/**
 * Create the coordinate_task tool for the main agent.
 *
 * This tool orchestrates the full coordinator pipeline:
 * 1. Spawns the coordinator agent with the decompose_task tool
 * 2. Coordinator analyzes the task and calls decompose_task
 * 3. Builds a TaskPipeline from the structured output
 * 4. Executes the pipeline via DAG scheduler (parallel where possible)
 * 5. Synthesizes results into a coherent response
 *
 * If the coordinator produces a single task, skips pipeline overhead
 * and delegates directly.
 */
export function createCoordinateTaskTool(
  orchestrator: SubagentOrchestrator,
  agentStore: AgentStore,
  parentSessionId: string,
  /** Nesting depth of the agent that owns this tool (main agent = 0). Spawns run at parentDepth + 1. */
  parentDepth = 0
): ICompletionOptionTools {
  // The coordinator and every pipeline worker are spawned from this tool's own
  // (parent) context, so they are siblings at the same depth.
  const childDepth = parentDepth + 1;
  return {
    toolFn: async (args: unknown) => {
      const parsed = CoordinateTaskParamsSchema.safeParse(args);

      if (!parsed.success) {
        const errors = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`coordinate_task: invalid parameters:\n${errors}`);
      }

      const { task, thoroughness } = parsed.data;

      // Validate coordinator agent exists
      if (!agentStore.hasAgent('coordinator')) {
        throw new Error(
          'coordinate_task: coordinator agent not found. Ensure coordinator.md exists in the agents directory.'
        );
      }

      // Phase 1: Run coordinator agent to decompose the task
      const capture: DecompositionCapture = { result: null };
      const decomposeTaskTool = createDecomposeTaskTool(capture);

      // Run coordinator with the decompose_task tool injected via additionalTools
      const coordinatorResult = await orchestrator.delegateToAgent({
        task,
        agentName: 'coordinator',
        thoroughness,
        parentSessionId,
        additionalTools: [decomposeTaskTool],
        depth: childDepth,
      });

      // Check if decomposition was captured
      if (!capture.result) {
        // Coordinator didn't call decompose_task - return its raw output
        return `Coordinator did not produce a task decomposition. Raw output:\n\n${coordinatorResult.summary}`;
      }

      // Phase 2: Build and execute the pipeline
      const pipeline = new TaskPipeline(capture.result);

      // Optimization: skip pipeline for single tasks (no shared context - solo agent has no siblings)
      if (pipeline.isSingleTask()) {
        const singleTask = pipeline.getSingleTask();
        const result = await executeSingleTask(
          orchestrator,
          singleTask,
          agentStore,
          parentSessionId,
          thoroughness,
          childDepth
        );
        return `**Single Task Execution** (pipeline overhead skipped)\n\n${result}`;
      }

      // Create pipeline-scoped shared context for inter-agent communication
      const sharedContext = new SharedAgentContext();

      // Execute the full pipeline
      const pipelineResult = await pipeline.execute(async (pipelineTask, dependencyResults) => {
        // Build context from dependency results
        let taskDescription = pipelineTask.description;
        if (dependencyResults.size > 0) {
          const contextParts: string[] = ['Context from prior tasks:'];
          for (const [depId, depResult] of dependencyResults) {
            const truncated =
              depResult.length > MAX_DEPENDENCY_CONTEXT_LENGTH
                ? depResult.slice(0, MAX_DEPENDENCY_CONTEXT_LENGTH) + '...(truncated)'
                : depResult;
            contextParts.push(`\n### Results from "${depId}":\n${truncated}`);
          }
          taskDescription = `${taskDescription}\n\n${contextParts.join('\n')}`;
        }

        const result = await orchestrator.delegateToAgent({
          task: taskDescription,
          agentName: resolveAgentName(pipelineTask.agentType, agentStore),
          thoroughness,
          parentSessionId,
          sharedContext,
          depth: childDepth,
        });

        return result.summary;
      });

      // Phase 3: Synthesize results
      const status = pipelineResult.success ? 'SUCCESS' : 'PARTIAL FAILURE';
      return `**Coordinated Execution Complete — ${status}**\n\n${pipelineResult.summary}`;
    },
    toolSchema: {
      name: 'coordinate_task',
      description: `Coordinate a complex task by decomposing it into subtasks and executing them via specialized agents.

**When to use this tool:**
- Complex, multi-step tasks that benefit from structured decomposition
- Tasks that involve exploration → implementation → review workflows
- Requests like "refactor X", "add feature Y with tests and docs", "investigate and fix Z"

**How it works:**
1. A coordinator agent analyzes the task and explores the codebase
2. It decomposes the work into subtasks with dependencies
3. Independent subtasks execute in parallel
4. Results are synthesized into a coherent response

**When NOT to use this tool:**
- Simple, single-step tasks (use agent_delegate directly)
- Quick lookups or searches (use explore agent)
- Tasks you can handle directly without delegation`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Clear description of the complex task to decompose and execute',
          },
          thoroughness: {
            type: 'string',
            enum: ['quick', 'medium', 'very_thorough'],
            description: 'How thorough the coordinator should be in its analysis (default: medium)',
          },
        },
        required: ['task'],
      },
    },
  };
}

/**
 * Execute a single task directly via agent delegation
 */
async function executeSingleTask(
  orchestrator: SubagentOrchestrator,
  task: DecomposedTask,
  agentStore: AgentStore,
  parentSessionId: string,
  thoroughness: 'quick' | 'medium' | 'very_thorough' = 'medium',
  depth?: number
): Promise<string> {
  const result = await orchestrator.delegateToAgent({
    task: task.description,
    agentName: resolveAgentName(task.agentType, agentStore),
    thoroughness,
    parentSessionId,
    depth,
  });

  return result.summary;
}

/**
 * Resolve agent type from decomposition to actual agent name.
 * Falls back to general-purpose if the specific agent doesn't exist.
 */
function resolveAgentName(agentType: string, agentStore: AgentStore): string {
  if (agentStore.hasAgent(agentType)) {
    return agentType;
  }

  // Fallback to general-purpose for unknown agent types
  console.debug(`[coordinator] Agent type "${agentType}" not found in agent store, falling back to general-purpose`);
  return 'general-purpose';
}
