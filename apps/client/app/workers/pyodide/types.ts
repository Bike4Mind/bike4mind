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
  output: string;
  error?: string;
  executionTime: number;
}

/** Messages sent from main thread to worker */
export type PyodideWorkerMessage =
  | { type: 'initialize'; baseUrl?: string }
  // timeoutMs is advisory: nothing inside the worker preempts a running Python step. The
  // enforcement is the parent calling interrupt(), which drops the sandbox frame.
  | { type: 'execute'; code: string; packages: string[]; timeoutMs: number }
  // Loads the code as a module and reads FUNCTION; paramsJson null describes it without calling run.
  | { type: 'call'; code: string; packages: string[]; paramsJson: string | null; timeoutMs: number }
  | { type: 'cancel' };

/** Messages sent from worker to main thread */
export type PyodideWorkerResponse =
  | { type: 'initializing'; progress: number; message: string }
  | { type: 'ready' }
  | { type: 'executing'; message: string }
  | { type: 'output'; output: string }
  | { type: 'result'; result: ExecutionResult }
  | { type: 'call-result'; result: FunctionCallResult }
  | { type: 'error'; error: string };
