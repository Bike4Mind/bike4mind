import type { ReplToolMap, ReplRunResult } from './ReplContext';

/**
 * The contract every REPL execution backend implements. ReplSession holds
 * one of these and delegates `setTools` / `runCode` to it.
 *
 * Two implementations today:
 * - `ReplContext` (in-process, fast, no isolation) - the default
 * - `WorkerReplExecutor` (worker_threads with resourceLimits, isolated)
 *
 * A future Quest 3c implementation will plug in an `IsolatedVmExecutor`
 * for full V8-isolate sandboxing. The `ReplExecutor` interface is the
 * stable seam that lets us swap backends without ReplSession or callers
 * changing.
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
