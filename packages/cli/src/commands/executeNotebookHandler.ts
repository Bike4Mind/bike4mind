/**
 * Jupyter Notebook Execution Handler
 *
 * Handles the jupyter_execute_notebook Keep command.
 * Orchestrates cell-by-cell execution of a notebook via local Jupyter server.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { z } from 'zod';
import type { JupyterClient } from '../utils/jupyterClient.js';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import type { Logger } from '../utils/Logger';

/**
 * Zod schema for validating execute notebook parameters.
 * Replaces unsafe `as` casts with proper runtime validation.
 */
const ExecuteNotebookParams = z.object({
  notebookJson: z.string().min(1, 'notebookJson is required'),
  sessionId: z.string().min(1, 'sessionId is required'),
  kernelName: z.string().default('python3'),
  timeoutPerCell: z.number().default(30000),
});

export type ExecuteNotebookParams = z.infer<typeof ExecuteNotebookParams>;

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: { kernelspec?: { name?: string } };
}

export interface ExecuteNotebookResult {
  success: boolean;
  cellsExecuted: number;
  cellsFailed: number;
  totalCodeCells: number;
  executedNotebook: string;
}

interface ExecuteNotebookDeps {
  jupyterClient: JupyterClient;
  wsManager: WebSocketConnectionManager | null;
  logger: Logger;
  requestId: string;
}

/**
 * Get cell source as string (handles both string and string[] formats).
 */
function getCellSource(cell: { source: string | string[] }): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

/**
 * Execute a Jupyter notebook cell by cell.
 *
 * @param params - Validated notebook execution parameters
 * @param deps - Dependencies (jupyter client, websocket manager, logger)
 * @returns Execution result with success status and executed notebook
 */
export async function executeNotebook(params: unknown, deps: ExecuteNotebookDeps): Promise<ExecuteNotebookResult> {
  const { jupyterClient, wsManager, logger, requestId } = deps;

  // Validate params with Zod (replaces unsafe casts)
  const parsed = ExecuteNotebookParams.parse(params);
  const { notebookJson, sessionId, kernelName, timeoutPerCell } = parsed;

  // Parse the notebook
  let notebook: Notebook;
  try {
    notebook = JSON.parse(notebookJson);
    if (!notebook.cells || !Array.isArray(notebook.cells)) {
      throw new Error('Invalid notebook: missing cells array');
    }
  } catch (parseErr) {
    throw new Error(
      `Failed to parse notebook JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
    );
  }

  // Count code cells
  const codeCells = notebook.cells.filter(c => c.cell_type === 'code');
  const totalCodeCells = codeCells.length;

  logger.info(`[Keep] Starting notebook execution: ${totalCodeCells} code cells, kernel: ${kernelName}`);

  // Create a temporary path for the kernel session
  // Uses crypto.randomUUID() to avoid collisions
  const tempNotebookPath = `/tmp/b4m-notebook-${randomUUID()}.ipynb`;

  // Save notebook to temp file (required by Jupyter for session)
  await fs.writeFile(tempNotebookPath, notebookJson, 'utf-8');

  let jupyterSession: { id: string; kernel: { id: string } } | null = null;
  let cellsExecuted = 0;
  let cellsFailed = 0;

  try {
    // Start kernel session
    logger.info(`[Keep] Starting Jupyter kernel: ${kernelName}`);
    jupyterSession = await jupyterClient.startSession(tempNotebookPath, kernelName);
    const kernelId = jupyterSession.kernel.id;
    const jupyterSessionId = jupyterSession.id;

    logger.info(`[Keep] Kernel started: session=${jupyterSessionId}, kernel=${kernelId}`);

    // Execute each code cell
    let codeCellIndex = 0;
    for (let i = 0; i < notebook.cells.length; i++) {
      const cell = notebook.cells[i];
      if (cell.cell_type !== 'code') continue;

      const cellCode = getCellSource(cell);
      if (!cellCode.trim()) {
        // Skip empty cells
        codeCellIndex++;
        continue;
      }

      logger.info(`[Keep] Executing cell ${codeCellIndex + 1}/${totalCodeCells}`);

      // Send progress update via WebSocket
      wsManager?.send({
        action: 'jupyter_cell_output',
        requestId,
        sessionId,
        jupyterSessionId,
        cellIndex: codeCellIndex,
        outputType: 'stream',
        content: { text: `Executing cell ${codeCellIndex + 1}/${totalCodeCells}...`, name: 'stdout' },
        executionCount: null,
        isComplete: false,
      });

      try {
        const cellResult = await jupyterClient.executeCell(kernelId, cellCode, timeoutPerCell);

        // Store outputs in the notebook structure
        cell.outputs = cellResult.outputs;
        cell.execution_count = cellResult.executionCount;

        if (cellResult.success) {
          cellsExecuted++;
          // Send completion update
          wsManager?.send({
            action: 'jupyter_cell_output',
            requestId,
            sessionId,
            jupyterSessionId,
            cellIndex: codeCellIndex,
            outputType: 'execute_result',
            content: {
              text: cellResult.outputs
                .map(o => {
                  if (o.text) return Array.isArray(o.text) ? o.text.join('') : o.text;
                  if (o.data && typeof o.data === 'object' && 'text/plain' in o.data) {
                    const textPlain = o.data['text/plain'];
                    return Array.isArray(textPlain) ? textPlain.join('') : String(textPlain);
                  }
                  return '';
                })
                .join(''),
              data: cellResult.outputs.find(o => o.data)?.data,
            },
            executionCount: cellResult.executionCount,
            isComplete: true,
          });
        } else {
          cellsFailed++;
          // Send error update
          wsManager?.send({
            action: 'jupyter_cell_output',
            requestId,
            sessionId,
            jupyterSessionId,
            cellIndex: codeCellIndex,
            outputType: 'error',
            content: {
              ename: cellResult.error?.ename || 'ExecutionError',
              evalue: cellResult.error?.evalue || 'Cell execution failed',
              traceback: cellResult.error?.traceback || [],
            },
            executionCount: cellResult.executionCount,
            isComplete: true,
          });
          logger.warn(
            `[Keep] Cell ${codeCellIndex + 1} failed: ${cellResult.error?.ename}: ${cellResult.error?.evalue}`
          );
        }
      } catch (cellErr) {
        cellsFailed++;
        const errMsg = cellErr instanceof Error ? cellErr.message : String(cellErr);
        wsManager?.send({
          action: 'jupyter_cell_output',
          requestId,
          sessionId,
          jupyterSessionId,
          cellIndex: codeCellIndex,
          outputType: 'error',
          content: {
            ename: 'ExecutionError',
            evalue: errMsg,
            traceback: [],
          },
          executionCount: null,
          isComplete: true,
        });
        logger.error(`[Keep] Cell ${codeCellIndex + 1} threw error: ${errMsg}`);
      }

      codeCellIndex++;
    }

    return {
      success: cellsFailed === 0,
      cellsExecuted,
      cellsFailed,
      totalCodeCells,
      executedNotebook: JSON.stringify(notebook),
    };
  } finally {
    // Always stop the kernel session
    if (jupyterSession) {
      try {
        logger.info(`[Keep] Stopping Jupyter session: ${jupyterSession.id}`);
        await jupyterClient.stopSession(jupyterSession.id);
      } catch (stopErr) {
        logger.warn(`[Keep] Failed to stop session: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
      }
    }
    // Clean up temp file
    try {
      await fs.unlink(tempNotebookPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
