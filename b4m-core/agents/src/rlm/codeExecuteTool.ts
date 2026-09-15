import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { BudgetExceededError, type ReplSession } from './ReplSession';
import { ReplSandboxRetiredError } from './replExecutor';

/**
 * Factory for the `code_execute` tool exposed to a ReAct agent.
 *
 * This is what turns a stateless ReAct loop into an RLM: when the agent
 * calls this tool, the JS it submits runs in the agent's persistent
 * `ReplSession`. Variables created with implicit-global assignment
 * survive across turns. The agent can also call other tools as async
 * functions inside the code (those bindings are configured separately
 * via `session.setTools()` before the agent runs).
 *
 * Returned shape matches `ICompletionOptionTools` exactly so it slots
 * into any `ReActAgent`'s tool array without further adaptation.
 *
 * See: apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md
 */

interface CodeExecuteParams {
  code?: string;
}

const TOOL_NAME = 'code_execute';

/**
 * Generic tool description. Hosts can pass `toolNames` via
 * `CodeExecuteToolDeps` to splice in a domain-specific list of available
 * in-REPL functions - otherwise the description tells the agent that
 * the REPL surface is whatever the host has wired via `session.setTools`.
 *
 * This package lives in `@bike4mind/agents` and is consumed by both the
 * tavern (which may wire 0+ read-only tavern tools) and a data-lake
 * answerer surface (which wires its data-lake tools). Hardcoding either set
 * here would mislead the other consumer's LLM.
 */
function buildToolDescription(toolNames: readonly string[]): string {
  const surface =
    toolNames.length > 0
      ? `The REPL has access to host-wired async tool functions: ${toolNames.join(', ')}.`
      : 'The REPL has access to whatever async tool functions the host has wired via session.setTools (none by default — stdlib only).';
  return (
    'Execute JavaScript in a persistent REPL bound to this agent session. ' +
    'Variables created without let/const/var (implicit globals) survive across turns. ' +
    `${surface} ` +
    'Use this when you need to: ' +
    '(1) iterate over many items without spawning an LLM call per item, ' +
    '(2) cache intermediate results across turns, ' +
    '(3) decompose a complex query into smaller programmatic sub-queries. ' +
    'For single-hop tasks, prefer direct tool calls.'
  );
}

export interface CodeExecuteToolDeps {
  session: ReplSession;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /**
   * Names of in-REPL functions exposed to the agent (e.g.
   * `['semanticSearch', 'keywordSearch']`). Spliced into the tool
   * description so the agent knows what's actually callable inside
   * `code_execute`. If omitted, the description tells the agent the
   * REPL has no host-wired tools (stdlib only).
   */
  toolNames?: readonly string[];
}

/**
 * Build a ToolDefinition-shaped object for the `code_execute` tool. The
 * caller is responsible for having already wired the data-lake / sub-LLM
 * tools into the session (via `session.setTools(buildDataLakeTools(...))`)
 * BEFORE the agent runs - otherwise the in-REPL function bindings won't
 * exist when the agent's code references them.
 */
export function makeCodeExecuteTool(deps: CodeExecuteToolDeps): ICompletionOptionTools {
  const { session, logger } = deps;

  return {
    toolFn: async (parameters?: unknown) => {
      const params = (parameters ?? {}) as CodeExecuteParams;
      const code = typeof params.code === 'string' ? params.code : '';

      if (!code.trim()) {
        return formatObservation({
          ok: false,
          stdout: '',
          error: 'code_execute called with empty `code` argument',
          truncated: false,
          durationMs: 0,
        });
      }

      logger?.log?.(
        `[code_execute] session=${session.sessionId} executions=${session.getUsage().executions} bytes=${code.length}`
      );

      try {
        const result = await session.runCode(code);

        if (result.error) {
          logger?.warn?.(`[code_execute] error: ${result.error.split('\n')[0]}`);
        }

        // A run that breached the host deadline or the memory limit RETURNS
        // (carrying whatever stdout was captured before the kill) rather than
        // throwing, so the terminal signal arrives on the result. Without this
        // the breaching call read as an ordinary failure and only the NEXT one
        // reported the sandbox gone - one wasted iteration, at the point the
        // agent most needs to stop calling.
        if (result.sandboxRetired) {
          logger?.error?.(`[code_execute] sandbox retired on this run: ${result.error ?? 'no error reported'}`);
        }
        return formatObservation({
          ok: result.error === null,
          stdout: result.stdout,
          error: result.error,
          truncated: result.truncated,
          durationMs: result.durationMs,
          sandboxRetired: result.sandboxRetired,
        });
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          logger?.warn?.(`[code_execute] budget exceeded: ${e.message}`);
          return formatObservation({
            ok: false,
            stdout: '',
            error: e.message,
            truncated: false,
            durationMs: 0,
            budgetExceeded: true,
          });
        }
        if (e instanceof ReplSandboxRetiredError) {
          // The sandbox is gone for good - a memory-limit breach, or a host
          // deadline that could only preempt a pending run by killing the
          // isolate. Say so in terminal language: the previous wording
          // ("[unexpected] ... has been disposed") read as transient, so the
          // agent kept re-calling code_execute and spending an iteration on
          // each attempt for the rest of the loop.
          logger?.error?.(`[code_execute] sandbox retired: ${e.message}`);
          return formatObservation({
            ok: false,
            stdout: '',
            error: e.message,
            truncated: false,
            durationMs: 0,
            sandboxRetired: true,
          });
        }
        // Unexpected - propagate as a string so the agent can see it
        const msg = e instanceof Error ? e.message : String(e);
        logger?.error?.(`[code_execute] unexpected: ${msg}`);
        return formatObservation({
          ok: false,
          stdout: '',
          error: `[unexpected] ${msg}`,
          truncated: false,
          durationMs: 0,
        });
      }
    },
    toolSchema: {
      name: TOOL_NAME,
      description: buildToolDescription(deps.toolNames ?? []),
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'JavaScript to execute in the persistent REPL. Top-level await is supported. ' +
              'Use console.log to surface output (truncated to ~7K chars). To persist a value ' +
              'across turns, assign it without let/const/var: `cachedResults = ...`',
          },
        },
        required: ['code'],
      },
    },
  };
}

interface ObservationFields {
  ok: boolean;
  stdout: string;
  error: string | null;
  truncated: boolean;
  durationMs: number;
  budgetExceeded?: boolean;
  sandboxRetired?: boolean;
}

/**
 * Format the run result into a string observation that the agent will
 * see in its conversation history. Keep it terse so it doesn't blow the
 * context, but include enough metadata that the agent knows what
 * happened (truncation, error, duration).
 */
function formatObservation(o: ObservationFields): string {
  const lines: string[] = [];
  if (o.budgetExceeded) {
    lines.push(`[code_execute] BUDGET EXCEEDED: ${o.error}`);
    lines.push('Cannot execute more code in this session. Provide your final answer now.');
    return lines.join('\n');
  }

  if (o.sandboxRetired) {
    lines.push(`[code_execute] SANDBOX UNAVAILABLE: ${o.error}`);
    lines.push(
      'The code sandbox has been shut down for this session and will not come back. ' +
        'Do not call code_execute again. Continue with your other tools, or answer from what you already have.'
    );
    // Output captured before the sandbox died is still the agent's best
    // material for the answer it now has to give without the REPL - and this
    // is the branch most likely to be short of it, so the truncation flag has
    // to be rendered HERE too. It used to be plumbed all the way from the
    // backend and then dropped one line above the `| stdout truncated` on the
    // ordinary path, so an agent answering from a partial buffer had no way
    // to know it was partial.
    if (o.stdout) {
      lines.push(`--- stdout (captured before shutdown${o.truncated ? ', truncated' : ''}) ---`);
      lines.push(o.stdout);
    }
    return lines.join('\n');
  }

  lines.push(`[code_execute] ${o.ok ? 'ok' : 'error'} | ${o.durationMs}ms${o.truncated ? ' | stdout truncated' : ''}`);
  if (o.stdout) {
    lines.push('--- stdout ---');
    lines.push(o.stdout);
  } else if (!o.error) {
    lines.push('(no stdout)');
  }
  if (o.error) {
    lines.push('--- error ---');
    lines.push(o.error);
  }
  return lines.join('\n');
}

export const CODE_EXECUTE_TOOL_NAME = TOOL_NAME;
