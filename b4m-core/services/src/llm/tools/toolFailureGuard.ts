import { Logger } from '@bike4mind/observability';
import { isTerminalToolError, type ICompletionOptionTools } from '@bike4mind/llm-adapters';

/** From this many consecutive failures of one tool, its error tells the model to stop retrying it. */
export const TOOL_FAILURE_NUDGE_AFTER = 2;
/** After this many consecutive failures of one tool, further calls to it are refused unrun. */
export const TOOL_FAILURE_BLOCK_AFTER = 4;

/**
 * Tools that report a failure in their result instead of throwing (imageGeneration,
 * delegateToAgent, knowledgeBaseRetrieve and others under tools/implementation) start it with this.
 */
const ERROR_RESULT_PREFIX = 'Error:';

/** Whether a tool result reports a failure in-band. Shared with telemetry/toolInvocationTelemetry.ts. */
export function isErrorToolResult(result: unknown): boolean {
  return typeof result === 'string' && result.startsWith(ERROR_RESULT_PREFIX);
}

/** Lookups whose failures depend on the input (a dead URL, a missing id), so a run of them is not a loop. */
const UNGUARDED_TOOLS = new Set(['web_fetch', 'retrieve_knowledge_content', 'file_read']);

function retryNudge(name: string, count: number): string {
  return (
    ` ("${name}" has now failed ${count} times in a row. Do not retry it with a similar input; ` +
    `change the approach or answer without it.)`
  );
}

/**
 * Nudges, then blocks, a tool after consecutive failures (per tool name, whatever the arguments).
 * Same scope as createWebSearchBudget (websearch/index.ts): call `reset()` wherever that budget is reset.
 */
export function createToolFailureGuard() {
  const consecutiveFailures = new Map<string, number>();
  // Read at failure time, not before the await, so parallel calls in one round each count. The
  // block check runs before the await, so every parallel call in one round still executes.
  const recordFailure = (name: string): number => {
    const count = (consecutiveFailures.get(name) ?? 0) + 1;
    consecutiveFailures.set(name, count);
    return count;
  };
  return {
    reset: () => consecutiveFailures.clear(),
    apply: (tools: ICompletionOptionTools[]): ICompletionOptionTools[] =>
      tools.map(tool => {
        const name = tool.toolSchema.name;
        if (UNGUARDED_TOOLS.has(name)) return tool;
        return {
          ...tool,
          toolFn: async (parameters, apiKey) => {
            const failures = consecutiveFailures.get(name) ?? 0;
            if (failures >= TOOL_FAILURE_BLOCK_AFTER) {
              Logger.globalInstance.log(`Tool ${name} blocked after ${failures} consecutive failures`);
              throw new Error(
                `Not run: "${name}" has failed ${failures} times in a row this turn. Do not call it again. ` +
                  `Answer now without it, working the result out yourself, and say plainly if anything ` +
                  `could not be computed.`
              );
            }
            let result: string;
            try {
              result = await tool.toolFn(parameters, apiKey);
            } catch (error) {
              // A terminal error (permission denial, out of credits, spend cap) ends the turn in the
              // adapters; it is not a failing tool, and rewrapping it would drop its quest error code.
              if (isTerminalToolError(error)) throw error;
              const count = recordFailure(name);
              if (count < TOOL_FAILURE_NUDGE_AFTER || !(error instanceof Error)) throw error;
              // A new error rather than appending to `error.message`: a tool that rejects with one
              // shared instance would otherwise stack a nudge per call.
              const nudged = new Error(error.message + retryNudge(name, count), { cause: error });
              nudged.name = error.name;
              throw nudged;
            }
            if (isErrorToolResult(result)) {
              const count = recordFailure(name);
              return count < TOOL_FAILURE_NUDGE_AFTER ? result : result + retryNudge(name, count);
            }
            consecutiveFailures.delete(name);
            return result;
          },
        };
      }),
  };
}
