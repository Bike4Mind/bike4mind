import type { ReplToolMap, ReplRunResult } from './ReplContext';

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
