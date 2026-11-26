/**
 * Pyodide worker message protocol.
 * Main -> Worker: PyodideWorkerMessage
 * Worker -> Main: PyodideWorkerResponse
 */

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  plots: string[]; // base64-encoded PNG images
  executionTime: number;
}

export interface FunctionCallResult {
  success: boolean;
  /** JSON text of the FUNCTION dict; guest data, parsed and validated by the parent. */
  contractJson?: string;
  /** JSON text of what run returned; absent for a describe call or a failed run. */
  valueJson?: string;
  /** JSON list of `{ path, message }` for output numbers whose Python type JSON cannot carry, such as 3.0. */
  outputProblemsJson?: string;
  output: string;
  error?: string;
  executionTime: number;
}

/** The worker's status once packages are loaded and guest code starts; the parent's time limit runs from it. */
export const SANDBOX_RUNNING_MESSAGE = 'Running...';

/** Messages sent from main thread to worker */
export type PyodideWorkerMessage =
  | { type: 'initialize'; baseUrl?: string }
  // timeoutMs is advisory: nothing inside the worker preempts a running Python step. The
  // enforcement is the parent calling interrupt(), which drops the sandbox frame.
  | { type: 'execute'; code: string; packages: string[]; timeoutMs: number }
  // Loads the code as a module and reads FUNCTION; paramsJson null describes it without calling run.
  // The worker echoes `nonce` on its call-result, which guest code never sees.
  // `files` are a saved tool's pinned data, written read-only under /data, which every call starts empty.
  | {
      type: 'call';
      code: string;
      packages: string[];
      paramsJson: string | null;
      timeoutMs: number;
      nonce: string;
      files?: { name: string; bytes: ArrayBuffer }[];
    }
  | { type: 'cancel' };

/** Messages sent from worker to main thread */
export type PyodideWorkerResponse =
  | { type: 'initializing'; progress: number; message: string }
  | { type: 'ready' }
  | { type: 'executing'; message: string }
  | { type: 'output'; output: string }
  | { type: 'result'; result: ExecutionResult }
  | { type: 'call-result'; result: FunctionCallResult; nonce?: unknown }
  | { type: 'error'; error: string };
