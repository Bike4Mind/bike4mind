import { promises as fs } from 'fs';
import { logger } from '../utils/Logger';
import { createJupyterClientFromEnv, JupyterClient } from '../utils/jupyterClient.js';
import { executeNotebook } from '../commands/executeNotebookHandler.js';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';

/**
 * Get a configured JupyterClient or throw an error if not configured.
 * Centralizes the Jupyter configuration check for all Jupyter Keep commands.
 */
function getRequiredJupyterClient(): JupyterClient {
  const client = createJupyterClientFromEnv();
  if (!client) {
    throw new Error(
      'Jupyter not configured. Set JUPYTER_SERVER_URL and optionally JUPYTER_TOKEN environment variables.'
    );
  }
  return client;
}

/**
 * Register the Keep command handler on a connected WebSocket manager - allows
 * the web HUD to execute commands on this machine via the B4M cloud relay.
 *
 * Pure bootstrap seam: no React hooks, no Zustand state. The connected
 * `wsManager` is passed in by the caller. Invoked from `buildLlmBackend`'s
 * `onWsConnected` callback at exactly the point the original inline registration
 * ran, so a registration throw still propagates into the WS try/catch and
 * triggers the SSE fallback.
 */
export function registerKeepHandlers(wsManager: WebSocketConnectionManager): void {
  wsManager.onAction('keep_command', async message => {
    const { commandType, params, requestId, originConnectionId } = message as {
      commandType: string;
      params: Record<string, unknown>;
      requestId: string;
      originConnectionId: string;
    };

    let result: unknown;
    let success = true;
    let error: string | undefined;

    try {
      switch (commandType) {
        case 'read_file': {
          const filePath = params.path as string;
          if (!filePath) throw new Error('Missing required param: path');
          logger.info(`[Keep] Reading file: ${filePath}`);
          const content = await fs.readFile(filePath, 'utf-8');
          result = { content, path: filePath };
          break;
        }
        case 'list_directory': {
          const dirPath = (params.path as string) || '.';
          logger.info(`[Keep] Listing directory: ${dirPath}`);
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          result = entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
          break;
        }

        // Jupyter kernel commands
        case 'jupyter_get_kernelspecs': {
          logger.info('[Keep] Getting Jupyter kernel specs');
          result = await getRequiredJupyterClient().getKernelSpecs();
          break;
        }

        case 'jupyter_start_kernel': {
          const notebookPath = params.notebookPath as string;
          const kernelName = params.kernelName as string | undefined;
          logger.info(`[Keep] Starting Jupyter kernel for: ${notebookPath}`);
          result = await getRequiredJupyterClient().startSession(notebookPath, kernelName);
          break;
        }

        case 'jupyter_stop_kernel': {
          const sessionId = params.sessionId as string;
          if (!sessionId) throw new Error('Missing required param: sessionId');
          logger.info(`[Keep] Stopping Jupyter session: ${sessionId}`);
          await getRequiredJupyterClient().stopSession(sessionId);
          result = { success: true, sessionId };
          break;
        }

        case 'jupyter_execute_cell': {
          const code = params.code as string;
          const kernelId = params.kernelId as string;
          const timeoutMs = (params.timeoutMs as number) || 30000;

          if (!code) throw new Error('Missing required param: code');
          if (!kernelId) throw new Error('Missing required param: kernelId');

          logger.info(`[Keep] Executing cell (kernel: ${kernelId}, code length: ${code.length})`);

          const cellResult = await getRequiredJupyterClient().executeCell(kernelId, code, timeoutMs);
          logger.info(
            `[Keep] Cell execution ${cellResult.success ? 'succeeded' : 'failed'} ` +
              `(outputs: ${cellResult.outputs.length}, execution_count: ${cellResult.executionCount})`
          );

          result = {
            success: cellResult.success,
            outputs: cellResult.outputs,
            executionCount: cellResult.executionCount,
            error: cellResult.error,
          };
          break;
        }

        case 'jupyter_execute_notebook': {
          // Full notebook execution - delegated to extracted handler
          result = await executeNotebook(params, {
            jupyterClient: getRequiredJupyterClient(),
            wsManager,
            logger,
            requestId,
          });
          break;
        }

        default:
          throw new Error(`Unknown command type: ${commandType}`);
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    // Send response back through relay
    logger.info(
      `[Keep] Sending response: success=${success}, originConnectionId=${originConnectionId?.slice(0, 12)}..., ` +
        `resultSize=${JSON.stringify(result)?.length ?? 0}`
    );
    try {
      wsManager.send({
        action: 'keep_command_response',
        requestId,
        originConnectionId,
        success,
        result,
        error,
      });
      logger.info('[Keep] Response sent successfully');
    } catch (sendErr) {
      logger.info(`[Keep] Failed to send response: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
  });
}
