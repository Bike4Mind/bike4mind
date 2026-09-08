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

/** Messages sent from main thread to worker */
export type PyodideWorkerMessage =
  | { type: 'initialize'; baseUrl?: string }
  // timeoutMs is advisory: nothing inside the worker preempts a running Python step. The
  // enforcement is the parent calling interrupt(), which drops the sandbox frame.
  | { type: 'execute'; code: string; packages: string[]; timeoutMs: number }
  | { type: 'cancel' };

/** Messages sent from worker to main thread */
export type PyodideWorkerResponse =
  | { type: 'initializing'; progress: number; message: string }
  | { type: 'ready' }
  | { type: 'executing'; message: string }
  | { type: 'output'; output: string }
  | { type: 'result'; result: ExecutionResult }
  | { type: 'error'; error: string };
