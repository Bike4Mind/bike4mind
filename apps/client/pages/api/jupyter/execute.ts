/**
 * Jupyter Notebook Execution Endpoint
 *
 * Triggers notebook execution on the user's local machine via CLI Keep command.
 * The CLI executes cells one-by-one and streams progress via WebSocket.
 *
 * POST /api/jupyter/execute
 *   Body: {
 *     notebookJson: string,  // The notebook JSON to execute
 *     sessionId: string,     // B4M session ID for tracking
 *     questId?: string,      // Optional quest ID for progress updates
 *     kernelName?: string,   // Jupyter kernel (default: python3)
 *     timeoutPerCell?: number // Timeout per cell in ms (default: 30000)
 *   }
 *   Returns: { requestId, sent, connections }
 *
 * Progress updates are streamed via WebSocket with action: 'jupyter_notebook_progress'
 */
import { baseApi } from '@server/middlewares/baseApi';
import { Resource } from 'sst';
import { sendToConnection } from '@server/websocket/utils';
import { Connection } from '@bike4mind/database/social';
import { Quest } from '@bike4mind/database/content';
import { randomUUID } from 'crypto';
import { z } from 'zod';

// WebSocket frame limit is 128KB (131072 bytes). We need room for the wrapper message
// (action, commandType, params, requestId, etc.) so limit notebook JSON to 120KB.
const WEBSOCKET_NOTEBOOK_LIMIT = 120 * 1024;

const ExecuteNotebookBody = z.object({
  notebookJson: z
    .string()
    .min(1, 'notebookJson is required')
    .max(WEBSOCKET_NOTEBOOK_LIMIT, `Notebook exceeds WebSocket size limit (${WEBSOCKET_NOTEBOOK_LIMIT / 1024}KB)`),
  sessionId: z.string().min(1, 'sessionId is required'),
  questId: z.string().optional(),
  kernelName: z.string().optional().default('python3'),
  timeoutPerCell: z.number().optional().default(30000),
});

const handler = baseApi({ auth: true }).post(async (req, res) => {
  const parsed = ExecuteNotebookBody.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    });
  }

  const { notebookJson, sessionId, questId, kernelName, timeoutPerCell } = parsed.data;
  const userId = req.user!.id;
  const requestId = randomUUID();

  let notebook: { cells: Array<{ cell_type: string }> };
  try {
    notebook = JSON.parse(notebookJson);
    if (!notebook.cells || !Array.isArray(notebook.cells)) {
      return res.status(400).json({
        error: 'Invalid notebook JSON: missing cells array',
      });
    }
  } catch (parseErr) {
    return res.status(400).json({
      error: 'Invalid notebook JSON',
      details: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
  }

  // Find CLI connections for this user (only CLI can execute notebooks locally)
  const connections = await Connection.find({ userId, source: 'cli' });

  if (connections.length === 0) {
    return res.status(503).json({
      error: 'No CLI connections available',
      hint: 'Start the B4M CLI and connect to execute notebooks locally.',
    });
  }

  // Update quest with initial notebook state if questId provided
  if (questId) {
    try {
      // Count only non-empty code cells - matches CLI behavior, which skips empty cells
      const codeCellCount = notebook.cells.filter((c: { cell_type: string; source?: string | string[] }) => {
        if (c.cell_type !== 'code') return false;
        const source = Array.isArray(c.source) ? c.source.join('') : c.source || '';
        return source.trim().length > 0;
      }).length;

      // Use findOneAndUpdate with userId filter to prevent unauthorized quest modification
      const updatedQuest = await Quest.findOneAndUpdate(
        { _id: questId, userId },
        {
          $set: {
            'jupyterNotebook.status': 'executing',
            'jupyterNotebook.kernelName': kernelName,
            'jupyterNotebook.cellCount': codeCellCount,
            'jupyterNotebook.executedCells': 0,
            'jupyterNotebook.startedAt': new Date(),
          },
        },
        { new: true }
      );

      if (!updatedQuest) {
        return res.status(403).json({
          error: 'Quest not found or access denied',
          hint: 'You can only execute notebooks on your own quests.',
        });
      }
    } catch (updateErr) {
      // Non-fatal - continue with execution even if quest update fails
      console.warn(`[Jupyter Execute] Failed to update quest ${questId}:`, updateErr);
    }
  }

  const endpoint = Resource.websocket.managementEndpoint;

  // Try CLI connections in order until one succeeds (handles stale connections)
  let lastError: unknown = null;
  let successfulConnectionId: string | null = null;

  for (const connection of connections) {
    try {
      await sendToConnection(connection.connectionId, endpoint, {
        action: 'keep_command' as const,
        commandType: 'jupyter_execute_notebook',
        params: {
          notebookJson,
          sessionId,
          kernelName,
          timeoutPerCell,
        },
        requestId,
        originConnectionId: 'api-jupyter-execute',
      });
      successfulConnectionId = connection.connectionId;
      break;
    } catch (err) {
      // Connection likely stale - try next one
      lastError = err;
      // Clean up stale connection record asynchronously
      Connection.deleteOne({ connectionId: connection.connectionId }).catch(() => {});
      continue;
    }
  }

  if (!successfulConnectionId) {
    return res.status(502).json({
      error: 'Failed to send command to CLI',
      details: lastError instanceof Error ? lastError.message : String(lastError),
      hint: 'All CLI connections may be stale. Try reconnecting the CLI.',
    });
  }

  console.log(`[Jupyter Execute] Sent notebook execution to CLI for user ${userId}, requestId=${requestId}`);

  res.json({
    requestId,
    sent: true,
    sessionId,
    kernelName,
    connections: connections.length,
    note: 'Notebook execution started. Progress updates will be sent via WebSocket.',
  });
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: {
      sizeLimit: '10mb', // Notebooks can be large
    },
  },
};

export default handler;
