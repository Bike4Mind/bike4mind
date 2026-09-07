import type { ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * The built-in backends, by name. Declared here rather than in ReplSession
 * because this is the file where the three are defined and ordered by
 * isolation. ReplSession derives both `ReplSessionOptions.executor` and
 * `ReplSession.executorChoice` from this union, so a fourth backend cannot be
 * added to one spelling of the list and forgotten in the other.
 */
export type ReplExecutorName = 'isolated' | 'worker' | 'in-process-unsafe';

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
