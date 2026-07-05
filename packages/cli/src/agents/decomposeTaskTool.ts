import { DecomposeTaskInputSchema, type DecomposeTaskInput } from '@bike4mind/agents';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

/**
 * Stores the decomposition result from the coordinator agent's tool call.
 *
 * The coordinator agent calls decompose_task as a tool. Instead of executing
 * a side-effect, the tool captures the structured task specs for the pipeline.
 */
export interface DecompositionCapture {
  result: DecomposeTaskInput | null;
}

/**
 * Create the decompose_task tool for the coordinator agent.
 *
 * This tool uses Zod validation on the structured input from the LLM's tool call,
 * avoiding the brittle regex-based JSON parsing that other approaches use.
 * The tool captures the decomposition result into the provided capture object,
 * which the coordinator harness reads after the agent completes.
 *
 * @param capture - Mutable object where the decomposition result is stored
 * @returns Tool definition compatible with the agent system
 */
export function createDecomposeTaskTool(capture: DecompositionCapture): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      // Guard against multiple calls - only the first decomposition is accepted
      if (capture.result !== null) {
        return 'Task decomposition already accepted. Do not call decompose_task again.';
      }

      const parsed = DecomposeTaskInputSchema.safeParse(args);

      if (!parsed.success) {
        const errors = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid task decomposition:\n${errors}`);
      }

      // Validate no duplicate task IDs
      const ids = parsed.data.tasks.map(t => t.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate task IDs: ${[...new Set(duplicates)].join(', ')}`);
      }

      // Store the validated result for the pipeline
      capture.result = parsed.data;

      // Return confirmation to the agent
      const taskSummary = parsed.data.tasks
        .map(t => {
          const deps = t.dependsOn.length > 0 ? ` (depends on: ${t.dependsOn.join(', ')})` : '';
          return `- [${t.agentType}] ${t.id}: ${t.description}${deps}`;
        })
        .join('\n');

      return `Task decomposition accepted (${parsed.data.tasks.length} tasks):\n${taskSummary}`;
    },
    toolSchema: {
      name: 'decompose_task',
      description: `Decompose a complex task into subtasks with dependencies.

Each subtask specifies:
- **id**: Unique identifier (e.g., "explore-auth", "implement-validation")
- **description**: Clear description of what needs to be done
- **agentType**: Which agent should handle it (explore, plan, general-purpose, review, test)
- **dependsOn**: IDs of tasks that must complete first (default: [])

The tasks form a DAG (directed acyclic graph). Tasks with no dependencies run first.
Tasks at the same dependency level run in parallel.

**Agent type guide:**
- **explore**: Read-only codebase search and analysis (fast, uses Haiku)
- **plan**: Break down a sub-problem into steps (read-only, uses Opus)
- **general-purpose**: Execute code changes, create files, run commands (full access)
- **review**: Analyze code quality, find bugs (read-only, uses Sonnet)
- **test**: Run and analyze test results (read-only + bash)

**Tips:**
- Start with explore tasks to gather context before implementation
- Use plan tasks for complex sub-problems that need further breakdown
- Chain explore → general-purpose → review for typical feature work
- Keep tasks focused — prefer many small tasks over few large ones`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Unique identifier for this task (e.g., "explore-auth", "implement-login")',
                },
                description: {
                  type: 'string',
                  description: 'Clear, specific description of what this task should accomplish',
                },
                agentType: {
                  type: 'string',
                  enum: ['explore', 'plan', 'general-purpose', 'review', 'test'],
                  description: 'Which specialized agent should handle this task',
                },
                dependsOn: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'IDs of tasks that must complete before this one starts (default: [])',
                },
              },
              required: ['id', 'description', 'agentType'],
            },
            description: 'Array of subtasks forming a dependency DAG',
          },
        },
        required: ['tasks'],
      },
    },
  };
}
