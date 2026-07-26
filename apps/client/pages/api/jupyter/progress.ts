/**
 * Jupyter Notebook Progress Endpoint (Browser -> Server)
 *
 * Reports notebook execution progress from the browser directly to the server,
 * updating the Quest document. This replaces the CLI WebSocket relay path
 * when executing notebooks from the browser.
 *
 * POST /api/jupyter/progress
 *   Body: {
 *     sessionId: string,
 *     questId: string,
 *     status: 'executing' | 'completed' | 'failed',
 *     cellIndex?: number,
 *     totalCells?: number,
 *     error?: string,
 *     executedNotebook?: string,
 *   }
 */
import { baseApi } from '@server/middlewares/baseApi';
import { Quest } from '@bike4mind/database/content';
import { z } from 'zod';

const ProgressBody = z.object({
  sessionId: z.string().min(1),
  questId: z.string().min(1),
  status: z.enum(['executing', 'completed', 'failed']),
  cellIndex: z.number().optional(),
  totalCells: z.number().optional(),
  error: z.string().optional(),
  executedNotebook: z.string().optional(),
});

const handler = baseApi({ auth: true }).post(async (req, res) => {
  const parsed = ProgressBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }

  const { questId, status, cellIndex, totalCells, error: errorMsg, executedNotebook } = parsed.data;
  const userId = req.user!.id;

  const updateData: Record<string, unknown> = {};

  if (status === 'executing') {
    updateData['jupyterNotebook.status'] = 'executing';
    if (cellIndex !== undefined) {
      updateData['jupyterNotebook.executedCells'] = cellIndex + 1;
    }
    if (totalCells !== undefined) {
      updateData['jupyterNotebook.cellCount'] = totalCells;
    }
  } else if (status === 'completed') {
    updateData['jupyterNotebook.status'] = 'completed';
    updateData['jupyterNotebook.completedAt'] = new Date();
    if (cellIndex !== undefined) {
      updateData['jupyterNotebook.executedCells'] = cellIndex + 1;
    }
  } else if (status === 'failed') {
    updateData['jupyterNotebook.status'] = 'failed';
    updateData['jupyterNotebook.completedAt'] = new Date();
    if (errorMsg) {
      updateData['jupyterNotebook.lastError'] = errorMsg;
    }
  }

  if (executedNotebook) {
    updateData['jupyterNotebook.executedNotebookJson'] = executedNotebook;
  }

  const updated = await Quest.findOneAndUpdate({ _id: questId, userId }, { $set: updateData }, { new: true });

  if (!updated) {
    return res.status(403).json({ error: 'Quest not found or access denied' });
  }

  res.json({ ok: true });
});

export default handler;
