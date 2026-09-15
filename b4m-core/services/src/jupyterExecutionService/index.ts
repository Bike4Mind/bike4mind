/**
 * Jupyter Execution Service
 *
 * Orchestrates notebook execution via Keep commands, handling cell-by-cell
 * execution with streaming progress updates and error recovery.
 *
 * Architecture Note: This service intentionally uses Keep commands (server-side execution)
 * rather than direct client-to-kernel WebSocket connections. This design provides:
 * - Security boundary between client and kernel
 * - Server-side logging and monitoring
 * - Consistent execution environment
 */

import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import {
  validateNotebookPath as validateNotebookPathBase,
  validateJupyterKernelName,
  JupyterValidationResult,
} from '@bike4mind/common';
import {
  NotebookDocument,
  NotebookCellOutput,
  getCellSource,
  setCellOutput,
} from '../llm/tools/implementation/jupyterNotebook/notebookStructure';

/**
 * Default timeout for cell execution (30 seconds)
 */
const DEFAULT_CELL_TIMEOUT_MS = 30_000;

/**
 * Maximum allowed cells per notebook to prevent resource exhaustion
 */
const MAX_CELLS_PER_NOTEBOOK = 200;

/**
 * Validate notebook path (requires .ipynb extension for backend)
 */
export function validateNotebookPath(path: string): JupyterValidationResult {
  return validateNotebookPathBase(path, true);
}

/**
 * Validate kernel name against whitelist
 */
export function validateKernelName(kernelName: string): JupyterValidationResult {
  return validateJupyterKernelName(kernelName);
}

/**
 * Type guard for Jupyter session response
 */
interface JupyterSessionResponse {
  id: string;
  kernel: {
    id: string;
    name?: string;
  };
}

function isJupyterSessionResponse(value: unknown): value is JupyterSessionResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string') return false;
  if (!obj.kernel || typeof obj.kernel !== 'object') return false;
  const kernel = obj.kernel as Record<string, unknown>;
  if (typeof kernel.id !== 'string') return false;
  return true;
}

/**
 * Type guard for cell execution response
 */
interface CellExecutionResponse {
  outputs: NotebookCellOutput[];
}

function isCellExecutionResponse(value: unknown): value is CellExecutionResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.outputs);
}

/**
 * Sanitize error message for LLM prompt to prevent prompt injection
 */
function sanitizeErrorForPrompt(error: string): string {
  // Remove potential prompt injection patterns
  return error.replace(/```/g, '---').replace(/\*\*/g, '').slice(0, 1000); // Limit length
}

/**
 * Jupyter notebook execution status
 */
export type JupyterExecutionStatus =
  | 'generating'
  | 'kernel_starting'
  | 'executing'
  | 'cell_complete'
  | 'error'
  | 'retrying'
  | 'completed'
  | 'failed';

/**
 * Progress update for notebook execution
 */
export interface JupyterNotebookProgress {
  questId: string;
  sessionId: string;
  status: JupyterExecutionStatus;
  cellIndex?: number;
  totalCells?: number;
  currentCellCode?: string;
  output?: unknown;
  error?: string;
  notebookPath?: string;
  fabFileId?: string;
}

/**
 * Cell output received from Jupyter kernel
 */
export interface JupyterCellOutput {
  requestId: string;
  sessionId: string;
  jupyterSessionId: string;
  cellIndex: number;
  outputType: 'stream' | 'execute_result' | 'display_data' | 'error';
  content: {
    text?: string;
    name?: string;
    data?: Record<string, unknown>;
    ename?: string;
    evalue?: string;
    traceback?: string[];
  };
  executionCount: number | null;
  isComplete: boolean;
}

/**
 * Keep command request interface
 */
export interface KeepCommand {
  commandType: string;
  params: Record<string, unknown>;
  requestId: string;
}

/**
 * Keep command result interface
 */
export interface KeepCommandResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Adapters required by the Jupyter execution service
 */
export interface JupyterExecutionAdapters {
  /** Send a Keep command and wait for result */
  sendKeepCommand: (command: KeepCommand) => Promise<KeepCommandResult>;
  /** Send progress update */
  onProgress: (progress: JupyterNotebookProgress) => Promise<void>;
  /** Send cell output */
  onCellOutput: (output: JupyterCellOutput) => Promise<void>;
  /** LLM backend for error recovery */
  llm: Pick<ICompletionBackend, 'complete'>;
  /** Logger */
  logger: Logger;
}

/**
 * Execution options
 */
export interface ExecutionOptions {
  questId: string;
  sessionId: string;
  notebookPath: string;
  kernelName?: string;
  maxCellRetries?: number;
  timeoutPerCell?: number; // ms
  /** Model to use for LLM-based cell error recovery (default: claude-sonnet-4-6) */
  cellFixModel?: string;
}

/**
 * Execution result
 */
export interface ExecutionResult {
  success: boolean;
  notebook: NotebookDocument;
  executionTime: number;
  cellsExecuted: number;
  cellsFailed: number;
  error?: string;
}

/**
 * Jupyter Execution Service
 *
 * Handles the orchestration of notebook execution through Keep commands.
 */
export class JupyterExecutionService {
  private adapters: JupyterExecutionAdapters;

  constructor(adapters: JupyterExecutionAdapters) {
    this.adapters = adapters;
  }

  /**
   * Execute a notebook cell-by-cell with error recovery
   */
  async executeNotebook(notebook: NotebookDocument, options: ExecutionOptions): Promise<ExecutionResult> {
    const startTime = Date.now();
    const {
      questId,
      sessionId,
      notebookPath,
      kernelName = 'python3',
      maxCellRetries = 3,
      timeoutPerCell = DEFAULT_CELL_TIMEOUT_MS,
      cellFixModel = 'claude-sonnet-4-6',
    } = options;
    const { logger } = this.adapters;

    // Input validation
    const pathValidation = validateNotebookPath(notebookPath);
    if (!pathValidation.valid) {
      return {
        success: false,
        notebook,
        executionTime: Date.now() - startTime,
        cellsExecuted: 0,
        cellsFailed: 0,
        error: pathValidation.error,
      };
    }

    const kernelValidation = validateKernelName(kernelName);
    if (!kernelValidation.valid) {
      return {
        success: false,
        notebook,
        executionTime: Date.now() - startTime,
        cellsExecuted: 0,
        cellsFailed: 0,
        error: kernelValidation.error,
      };
    }

    // Check cell count limit
    const cellCount = this.countCodeCells(notebook);
    if (cellCount > MAX_CELLS_PER_NOTEBOOK) {
      return {
        success: false,
        notebook,
        executionTime: Date.now() - startTime,
        cellsExecuted: 0,
        cellsFailed: 0,
        error: `Notebook has ${cellCount} code cells, exceeds maximum of ${MAX_CELLS_PER_NOTEBOOK}`,
      };
    }

    let cellsExecuted = 0;
    let cellsFailed = 0;

    // Send initial progress
    await this.adapters.onProgress({
      questId,
      sessionId,
      status: 'kernel_starting',
      totalCells: cellCount,
      notebookPath,
    });

    // Start kernel session via Keep
    logger.info(`[JupyterExecution] Starting kernel for: ${notebookPath}`);
    const startKernelResult = await this.adapters.sendKeepCommand({
      commandType: 'jupyter_start_kernel',
      params: { notebookPath, kernelName },
      requestId: this.generateRequestId(),
    });

    if (!startKernelResult.success) {
      await this.adapters.onProgress({
        questId,
        sessionId,
        status: 'failed',
        error: startKernelResult.error || 'Failed to start Jupyter kernel',
      });

      return {
        success: false,
        notebook,
        executionTime: Date.now() - startTime,
        cellsExecuted: 0,
        cellsFailed: 0,
        error: startKernelResult.error,
      };
    }

    // Validate session response structure
    if (!isJupyterSessionResponse(startKernelResult.result)) {
      const error = 'Invalid Jupyter session response: missing id or kernel.id';
      logger.error(`[JupyterExecution] ${error}`);
      await this.adapters.onProgress({ questId, sessionId, status: 'failed', error });
      return {
        success: false,
        notebook,
        executionTime: Date.now() - startTime,
        cellsExecuted: 0,
        cellsFailed: 0,
        error,
      };
    }

    const jupyterSession = startKernelResult.result;
    const jupyterSessionId = jupyterSession.id;
    const kernelId = jupyterSession.kernel.id;

    logger.info(`[JupyterExecution] Kernel started, session: ${jupyterSessionId}, kernel: ${kernelId}`);

    // Execute each code cell
    let codeCellIndex = 0;
    for (let i = 0; i < notebook.cells.length; i++) {
      const cell = notebook.cells[i];
      if (cell.cell_type !== 'code') continue;

      const cellCode = getCellSource(cell);
      if (!cellCode.trim()) continue;

      await this.adapters.onProgress({
        questId,
        sessionId,
        status: 'executing',
        cellIndex: codeCellIndex,
        totalCells: this.countCodeCells(notebook),
        currentCellCode: cellCode.slice(0, 200), // First 200 chars for preview
      });

      let retries = 0;
      let cellSuccess = false;
      let currentCode = cellCode;
      let outputs: NotebookCellOutput[] = [];

      while (!cellSuccess && retries <= maxCellRetries) {
        try {
          // Execute the cell with timeout
          const executePromise = this.adapters.sendKeepCommand({
            commandType: 'jupyter_execute_cell',
            params: {
              kernelId,
              code: currentCode,
              timeoutMs: timeoutPerCell,
            },
            requestId: this.generateRequestId(),
          });

          // Safety timeout slightly longer than cell timeout to allow proper error propagation
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Cell execution timed out after ${timeoutPerCell}ms`)),
              timeoutPerCell + 5000
            );
          });

          const executeResult = await Promise.race([executePromise, timeoutPromise]);

          if (executeResult.success) {
            // Validate response structure
            const cellResponse = isCellExecutionResponse(executeResult.result) ? executeResult.result : { outputs: [] };
            outputs = cellResponse.outputs;
            setCellOutput(notebook, i, outputs, codeCellIndex + 1);
            cellSuccess = true;
            cellsExecuted++;

            await this.adapters.onProgress({
              questId,
              sessionId,
              status: 'cell_complete',
              cellIndex: codeCellIndex,
              totalCells: this.countCodeCells(notebook),
              output: outputs,
            });
          } else {
            throw new Error(executeResult.error || 'Cell execution failed');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          if (retries < maxCellRetries) {
            // Attempt to fix the cell with LLM
            await this.adapters.onProgress({
              questId,
              sessionId,
              status: 'retrying',
              cellIndex: codeCellIndex,
              error: errorMessage,
            });

            try {
              currentCode = await this.requestCellFix(currentCode, errorMessage, cellFixModel);
              retries++;
              logger.info(`[JupyterExecution] Retrying cell ${codeCellIndex} (attempt ${retries})`);
            } catch (fixError) {
              logger.error(`[JupyterExecution] Failed to get cell fix: ${fixError}`);
              break;
            }
          } else {
            // Max retries exceeded
            cellsFailed++;
            outputs = [
              {
                output_type: 'error',
                ename: 'ExecutionError',
                evalue: errorMessage,
                traceback: [errorMessage],
              },
            ];
            setCellOutput(notebook, i, outputs, codeCellIndex + 1);

            await this.adapters.onProgress({
              questId,
              sessionId,
              status: 'error',
              cellIndex: codeCellIndex,
              error: `Cell failed after ${maxCellRetries} retries: ${errorMessage}`,
            });
            break;
          }
        }
      }

      codeCellIndex++;
    }

    // Stop the kernel session
    try {
      await this.adapters.sendKeepCommand({
        commandType: 'jupyter_stop_kernel',
        params: { sessionId: jupyterSessionId },
        requestId: this.generateRequestId(),
      });
      logger.info(`[JupyterExecution] Kernel session stopped: ${jupyterSessionId}`);
    } catch (stopError) {
      logger.warn(`[JupyterExecution] Failed to stop kernel: ${stopError}`);
    }

    const success = cellsFailed === 0;
    const executionTime = Date.now() - startTime;

    // Send final progress
    await this.adapters.onProgress({
      questId,
      sessionId,
      status: success ? 'completed' : 'failed',
      totalCells: this.countCodeCells(notebook),
      error: success ? undefined : `${cellsFailed} cells failed to execute`,
    });

    return {
      success,
      notebook,
      executionTime,
      cellsExecuted,
      cellsFailed,
      error: success ? undefined : `${cellsFailed} cells failed to execute`,
    };
  }

  /**
   * Request LLM to fix a failed cell
   */
  private async requestCellFix(originalCode: string, error: string, model: string): Promise<string> {
    // Sanitize error message to prevent prompt injection
    const sanitizedError = sanitizeErrorForPrompt(error);

    const prompt = `The following Python code failed with an error. Please fix the code and return ONLY the corrected Python code, nothing else.

Original Code:
---
${originalCode.slice(0, 2000)}
---

Error:
${sanitizedError}

Fixed Code:`;

    // Collect the response using the streaming callback pattern
    let responseText = '';
    await this.adapters.llm.complete(
      model,
      [{ role: 'user', content: prompt }],
      { maxTokens: 2000, temperature: 0.3 },
      async texts => {
        responseText = texts.filter(t => t !== null && t !== undefined).join('');
      }
    );

    // Try multiple extraction patterns for robustness
    // Pattern 1: Markdown code block with python
    const pythonBlockMatch = responseText.match(/```python\n?([\s\S]*?)```/);
    if (pythonBlockMatch) {
      return pythonBlockMatch[1].trim();
    }

    // Pattern 2: Generic code block
    const genericBlockMatch = responseText.match(/```\n?([\s\S]*?)```/);
    if (genericBlockMatch) {
      return genericBlockMatch[1].trim();
    }

    // Pattern 3: Code between triple dashes (our prompt format)
    const dashBlockMatch = responseText.match(/---\n?([\s\S]*?)---/);
    if (dashBlockMatch) {
      return dashBlockMatch[1].trim();
    }

    // Fallback: Validate response looks like code before returning
    const trimmed = responseText.trim();
    if (trimmed.includes('import ') || trimmed.includes('def ') || trimmed.includes('=')) {
      return trimmed;
    }

    // If response doesn't look like code, throw to prevent executing text
    throw new Error('LLM response does not appear to be valid Python code');
  }

  /**
   * Count the number of code cells in a notebook
   */
  private countCodeCells(notebook: NotebookDocument): number {
    return notebook.cells.filter(c => c.cell_type === 'code').length;
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Create a JupyterExecutionService with the given adapters
 */
export function createJupyterExecutionService(adapters: JupyterExecutionAdapters): JupyterExecutionService {
  return new JupyterExecutionService(adapters);
}
