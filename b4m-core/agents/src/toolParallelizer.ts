/**
 * Tool Parallelizer Module
 *
 * Enables parallel execution of independent (read-only) tools for performance improvement.
 * Write tools are always executed sequentially for safety.
 */

/**
 * Information about a tool call from the LLM
 */
export interface ToolUseInfo {
  name: string;
  arguments?: string;
  /** Tool call ID from the API (e.g. call_xxx for OpenAI, toolu_xxx for Anthropic) */
  id?: string;
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
  toolName: string;
  result?: string;
  error?: Error;
  status: 'fulfilled' | 'rejected';
  /** Confidence score (0.0 - 1.0) for the tool execution result.
   *  Used by the confidence engine to gate autonomous continuation.
   *  - 1.0 = deterministic success (math verified, HTTP 200)
   *  - 0.7 = default stub (no scorer registered)
   *  - 0.0 = definitive failure
   */
  confidence?: number;
  /** How the confidence score was determined */
  confidenceSource?: 'deterministic' | 'llm_self_report' | 'heuristic' | 'default';
}

/**
 * Plan for executing tools in batches
 */
export interface ToolExecutionPlan {
  /** Read-only tools that can be executed in parallel */
  parallelBatch: ToolUseInfo[];
  /** Write tools that must be executed sequentially after parallel batch */
  sequentialBatch: ToolUseInfo[];
  /** Original tool order for maintaining message order */
  originalOrder: string[];
}

/**
 * Function to determine if a tool is read-only (parallelizable).
 * Returns true for tools that can be safely executed in parallel.
 */
export type IsReadOnlyToolFn = (toolName: string) => boolean;

/**
 * Thrown by executeToolsInParallel when the AbortSignal fires mid-batch.
 *
 * Carries the results gathered before the abort so the caller can still pair a
 * tool_result with every advertised tool_use (see ReActAgent's abort backfill)
 * instead of discarding completed work when the throw unwinds the batch. The
 * message stays 'Tool execution aborted' so isAbortError and existing
 * string-matching call sites (and tests) keep working unchanged.
 */
export class ToolExecutionAbortedError extends Error {
  constructor(public readonly partialResults: Map<string, ToolResult>) {
    super('Tool execution aborted');
    this.name = 'ToolExecutionAbortedError';
  }
}

/**
 * Default set of known write (non-parallelizable) tools.
 * These tools can modify state and should always be sequential.
 */
export const DEFAULT_WRITE_TOOLS = new Set([
  'edit_file',
  'edit_local_file',
  'create_file',
  'delete_file',
  'shell_execute',
  'bash_execute',
  'git_commit',
  'git_push',
]);

/**
 * Default read-only check based on known write tools.
 * Any tool not in the write tools set is considered read-only.
 */
export function defaultIsReadOnlyTool(toolName: string): boolean {
  return !DEFAULT_WRITE_TOOLS.has(toolName);
}

/**
 * Generate a unique ID for a tool call based on name and arguments.
 */
export function getToolId(tool: ToolUseInfo): string {
  return `${tool.name}_${JSON.stringify(tool.arguments)}`;
}

/**
 * Categorize tools into parallel (read-only) and sequential (write) batches.
 *
 * @param toolsUsed - Array of tool calls from the LLM
 * @param isReadOnly - Function to determine if a tool is read-only (default: checks against known write tools)
 * @returns Execution plan with parallel and sequential batches
 */
export function categorizeTools(
  toolsUsed: ToolUseInfo[],
  isReadOnly: IsReadOnlyToolFn = defaultIsReadOnlyTool
): ToolExecutionPlan {
  const parallelBatch: ToolUseInfo[] = [];
  const sequentialBatch: ToolUseInfo[] = [];
  const originalOrder: string[] = [];

  for (const tool of toolsUsed) {
    originalOrder.push(getToolId(tool));

    if (isReadOnly(tool.name)) {
      parallelBatch.push(tool);
    } else {
      sequentialBatch.push(tool);
    }
  }

  return {
    parallelBatch,
    sequentialBatch,
    originalOrder,
  };
}

/**
 * Execute tools according to the execution plan.
 * Parallel batch runs concurrently using Promise.allSettled().
 * Sequential batch runs one at a time after the parallel batch completes.
 *
 * @param plan - Execution plan from categorizeTools()
 * @param executor - Function to execute a single tool
 * @param signal - Optional AbortSignal for cancellation
 * @returns Map of tool IDs to their results
 */
export async function executeToolsInParallel(
  plan: ToolExecutionPlan,
  executor: (tool: ToolUseInfo) => Promise<string>,
  signal?: AbortSignal
): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>();

  // Check for abort before starting
  if (signal?.aborted) {
    throw new ToolExecutionAbortedError(results);
  }

  // Phase 1: Execute read-only tools in parallel
  if (plan.parallelBatch.length > 0) {
    const parallelPromises = plan.parallelBatch.map(async tool => {
      const toolId = getToolId(tool);

      // Check abort before each tool
      if (signal?.aborted) {
        return {
          toolId,
          result: {
            toolName: tool.name,
            error: new Error('Tool execution aborted'),
            status: 'rejected' as const,
          },
        };
      }

      try {
        const result = await executor(tool);
        return {
          toolId,
          result: {
            toolName: tool.name,
            result,
            status: 'fulfilled' as const,
          },
        };
      } catch (error) {
        return {
          toolId,
          result: {
            toolName: tool.name,
            error: error instanceof Error ? error : new Error(String(error)),
            status: 'rejected' as const,
          },
        };
      }
    });

    const settledResults = await Promise.allSettled(parallelPromises);

    for (const settled of settledResults) {
      if (settled.status === 'fulfilled') {
        results.set(settled.value.toolId, settled.value.result);
      }
    }
  }

  // Check for abort before sequential phase
  if (signal?.aborted) {
    throw new ToolExecutionAbortedError(results);
  }

  // Phase 2: Execute write tools sequentially
  for (const tool of plan.sequentialBatch) {
    const toolId = getToolId(tool);

    // Check abort before each tool
    if (signal?.aborted) {
      results.set(toolId, {
        toolName: tool.name,
        error: new Error('Tool execution aborted'),
        status: 'rejected',
      });
      throw new ToolExecutionAbortedError(results);
    }

    try {
      const result = await executor(tool);
      results.set(toolId, {
        toolName: tool.name,
        result,
        status: 'fulfilled',
      });
    } catch (error) {
      results.set(toolId, {
        toolName: tool.name,
        error: error instanceof Error ? error : new Error(String(error)),
        status: 'rejected',
      });
    }
  }

  return results;
}

/**
 * Get tool result in original order for message building.
 *
 * @param results - Map of tool results from executeToolsInParallel()
 * @param originalOrder - Original tool order from execution plan
 * @returns Array of results in original order
 */
export function getResultsInOrder(results: Map<string, ToolResult>, originalOrder: string[]): ToolResult[] {
  return originalOrder
    .map(toolId => results.get(toolId))
    .filter((result): result is ToolResult => result !== undefined);
}

/**
 * Check if parallel execution should be used.
 * Returns true only if there are multiple read-only tools that can benefit
 * from parallel execution.
 *
 * @param toolsUsed - Array of tool calls
 * @param isReadOnly - Function to determine if a tool is read-only
 * @returns true if parallel execution would be beneficial
 */
export function shouldUseParallelExecution(
  toolsUsed: ToolUseInfo[],
  isReadOnly: IsReadOnlyToolFn = defaultIsReadOnlyTool
): boolean {
  if (toolsUsed.length < 2) {
    return false; // No benefit for single tool
  }

  // Count read-only tools
  const readOnlyCount = toolsUsed.filter(tool => isReadOnly(tool.name)).length;

  // Only parallelize if we have 2+ read-only tools
  return readOnlyCount >= 2;
}
