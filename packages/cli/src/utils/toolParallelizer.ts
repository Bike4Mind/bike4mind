/**
 * Enables parallel execution of independent (read-only) tools; write tools
 * (prompt_always category) always run sequentially for safety.
 *
 * Primarily used for testing the CLI-specific tool safety integration. The
 * actual parallel execution logic lives in @bike4mind/agents.
 */

import { isReadOnlyTool, type ToolCategory } from '../config/toolSafety.js';

// Re-export isReadOnlyTool for backward compatibility with tests
export { isReadOnlyTool };

/**
 * Information about a tool call from the LLM
 */
export interface ToolUseInfo {
  name: string;
  arguments?: string;
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
  toolName: string;
  result?: string;
  error?: Error;
  status: 'fulfilled' | 'rejected';
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
 * Categorize tools into parallel (read-only) and sequential (write) batches.
 *
 * @param toolsUsed - Array of tool calls from the LLM
 * @param customCategories - Optional custom category overrides
 * @returns Execution plan with parallel and sequential batches
 */
export function categorizeTools(
  toolsUsed: ToolUseInfo[],
  customCategories?: Record<string, ToolCategory>
): ToolExecutionPlan {
  const parallelBatch: ToolUseInfo[] = [];
  const sequentialBatch: ToolUseInfo[] = [];
  const originalOrder: string[] = [];

  for (const tool of toolsUsed) {
    // Create unique identifier for ordering
    const toolId = `${tool.name}_${JSON.stringify(tool.arguments)}`;
    originalOrder.push(toolId);

    if (isReadOnlyTool(tool.name, customCategories)) {
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
    throw new Error('Tool execution aborted');
  }

  // Phase 1: Execute read-only tools in parallel
  if (plan.parallelBatch.length > 0) {
    const parallelPromises = plan.parallelBatch.map(async tool => {
      const toolId = `${tool.name}_${JSON.stringify(tool.arguments)}`;

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
      // Promise.allSettled never rejects, so this shouldn't happen,
      // but handle it defensively
    }
  }

  // Check for abort before sequential phase
  if (signal?.aborted) {
    throw new Error('Tool execution aborted');
  }

  // Phase 2: Execute write tools sequentially
  for (const tool of plan.sequentialBatch) {
    const toolId = `${tool.name}_${JSON.stringify(tool.arguments)}`;

    // Check abort before each tool
    if (signal?.aborted) {
      results.set(toolId, {
        toolName: tool.name,
        error: new Error('Tool execution aborted'),
        status: 'rejected',
      });
      throw new Error('Tool execution aborted');
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
      // For sequential tools, we might want to stop on error
      // but returning the error allows the caller to decide
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
 * @param customCategories - Optional custom category overrides
 * @returns true if parallel execution would be beneficial
 */
export function shouldUseParallelExecution(
  toolsUsed: ToolUseInfo[],
  customCategories?: Record<string, ToolCategory>
): boolean {
  if (toolsUsed.length < 2) {
    return false; // No benefit for single tool
  }

  const readOnlyCount = toolsUsed.filter(tool => isReadOnlyTool(tool.name, customCategories)).length;

  // Only parallelize if we have 2+ read-only tools
  return readOnlyCount >= 2;
}
