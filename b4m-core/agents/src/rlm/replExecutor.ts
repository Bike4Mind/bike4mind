import type { ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * The built-in backends, by name, ordered by isolation. Declared here rather
 * than in ReplSession because this is the file where the three are defined.
 * ReplSession derives both `ReplSessionOptions.executor` and
 * `ReplSession.executorChoice` from this list, so a fourth backend cannot be
 * added to one spelling of it and forgotten in the other.
 *
 * A runtime array rather than a bare type union so the error messages that
 * enumerate the backends read from the same source the type does - a fourth
 * name added here reaches those strings without anyone remembering to edit
 * them.
 */
export const REPL_EXECUTOR_NAMES = ['isolated', 'worker', 'in-process-unsafe'] as const;

export type ReplExecutorName = (typeof REPL_EXECUTOR_NAMES)[number];

/** The backends quoted for an error message: `'isolated' | 'worker' | ...`. */
export const replExecutorNameList = (): string => REPL_EXECUTOR_NAMES.map(n => `'${n}'`).join(' | ');

/**
 * Thrown when a backend is asked to run code after it has been retired -
 * disposed by its owner, or killed out from under us by a memory-limit breach
 * or a host deadline.
 *
 * Distinct from an ordinary run error because the condition is TERMINAL for
 * the session: nothing the caller does brings the sandbox back. `code_execute`
 * reports it to the agent as a capability that is gone rather than a step that
 * failed, so an agent loop stops re-calling a tool that cannot work and paying
 * an iteration for each attempt.
 *
 * Retirement is reported two ways, and every backend must use both. The run
 * that CAUSES the retirement resolves with `ReplRunResult.sandboxRetired`
 * (see ReplContext.ts), so the stdout it printed before the kill survives; a
 * throw would discard exactly the material the agent now has to answer from.
 * This error is for the calls that arrive AFTER, where there is no run and so
 * nothing to preserve.
 */
export class ReplSandboxRetiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplSandboxRetiredError';
  }
}

/**
 * The contract every REPL execution backend implements. ReplSession holds
 * one of these and delegates `setTools` / `runCode` to it.
 *
 * Three implementations today, in descending order of isolation. There is no
 * default: `ReplSessionOptions.executor` is required, because which of these
 * a caller gets is a trust decision, not a performance one.
 * - `IsolatedVmExecutor` (`'isolated'`) - a V8 isolate, a real trust
 *   boundary. The only one that may run code we did not write.
 * - `WorkerReplExecutor` (`'worker'`) - worker_threads with resourceLimits.
 *   Resource isolation, not a trust boundary.
 * - `ReplContext` (`'in-process-unsafe'`) - the host realm. Not a sandbox.
 *
 * This interface is the stable seam that lets us swap backends without
 * ReplSession or callers changing.
 */
export interface ReplExecutor {
  /** Add or replace tool bindings in the executor's context. */
  setTools(tools: ReplToolMap): void;

  /** Run a code block. Returns observation-shaped result. */
  runCode(code: string): Promise<ReplRunResult>;

  /** Names of user-defined globals (best-effort, mostly for debugging). */
  listGlobals?(): string[];

  /** Release any resources (worker threads, isolates). */
  dispose?(): Promise<void> | void;
}
