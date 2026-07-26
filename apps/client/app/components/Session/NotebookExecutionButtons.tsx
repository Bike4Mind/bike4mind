/**
 * NotebookExecutionButtons - Execute Jupyter notebooks directly from the browser
 *
 * Primary path: connects to the user's local Jupyter server from the browser
 * (no CLI needed). Falls back to CLI relay if no browser Jupyter config is set.
 */

import { Box, Button, CircularProgress, Typography } from '@mui/joy';
import { CheckCircleOutline, ErrorOutline, PlayArrow } from '@mui/icons-material';
import { FC, useState, useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import {
  JupyterBrowserClient,
  JupyterBrowserError,
  getStoredJupyterConfig,
} from '@client/app/utils/jupyterBrowserClient';
import type { IChatHistoryItem } from '@bike4mind/common';

export interface NotebookExecutionButtonsProps {
  jupyterNotebook?: IChatHistoryItem['jupyterNotebook'];
  notebookContent?: string;
  sessionId?: string;
  messageId?: string;
}

/**
 * Safely parse sessionStorage data with error handling.
 */
function safeParseStoredData(
  storageKey: string | null
): { started?: boolean; error?: string; completed?: boolean } | null {
  if (!storageKey || typeof window === 'undefined') return null;

  try {
    const storedData = sessionStorage.getItem(storageKey);
    if (!storedData) return null;
    return JSON.parse(storedData);
  } catch {
    if (storageKey) {
      sessionStorage.removeItem(storageKey);
    }
    return null;
  }
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
}

function getCellSource(cell: { source: string | string[] }): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

export const NotebookExecutionButtons: FC<NotebookExecutionButtonsProps> = ({
  jupyterNotebook: initialJupyterNotebook,
  notebookContent,
  sessionId,
  messageId,
}) => {
  const { subscribeToAction } = useWebsocket();
  const storageKey = messageId ? `notebook-exec-${messageId}` : null;
  const parsedData = safeParseStoredData(storageKey);

  const [isExecuting, setIsExecuting] = useState(false);
  const [executionStarted, setExecutionStarted] = useState(() => parsedData?.started || false);
  const [error, setError] = useState<string | null>(() => parsedData?.error || null);
  const abortRef = useRef(false);

  const [liveProgress, setLiveProgress] = useState<{
    status?: string;
    cellIndex?: number;
    totalCells?: number;
    error?: string;
  }>({});

  // Subscribe to WebSocket progress updates (for CLI fallback path)
  useEffect(() => {
    if (!messageId || !sessionId) return;

    const unsubscribe = subscribeToAction('jupyter_notebook_progress', async message => {
      const progressMsg = message as {
        action: string;
        questId?: string;
        sessionId?: string;
        status?: string;
        cellIndex?: number;
        totalCells?: number;
        error?: string;
      };

      if (progressMsg.questId === messageId || progressMsg.sessionId === sessionId) {
        setLiveProgress({
          status: progressMsg.status,
          cellIndex: progressMsg.cellIndex,
          totalCells: progressMsg.totalCells,
          error: progressMsg.error,
        });

        if (storageKey) {
          if (progressMsg.status === 'completed') {
            sessionStorage.setItem(storageKey, JSON.stringify({ completed: true }));
          } else if (progressMsg.status === 'failed') {
            sessionStorage.setItem(storageKey, JSON.stringify({ error: progressMsg.error || 'Execution failed' }));
          }
        }
      }
    });

    return unsubscribe;
  }, [messageId, sessionId, subscribeToAction, storageKey]);

  const reportProgress = async (
    status: 'executing' | 'completed' | 'failed',
    cellIndex?: number,
    totalCells?: number,
    errMsg?: string
  ) => {
    if (!messageId || !sessionId) return;
    try {
      await api.post('/api/jupyter/progress', {
        sessionId,
        questId: messageId,
        status,
        cellIndex,
        totalCells,
        error: errMsg,
      });
    } catch {
      // Non-fatal: progress reporting is best-effort
    }
  };

  const handleBrowserExecute = async () => {
    if (!notebookContent || !sessionId) return;

    const jupyterConfig = getStoredJupyterConfig();
    if (!jupyterConfig) return;

    setIsExecuting(true);
    setExecutionStarted(true);
    setError(null);
    abortRef.current = false;

    if (storageKey) {
      sessionStorage.setItem(storageKey, JSON.stringify({ started: true }));
    }

    let notebook: { cells: NotebookCell[]; metadata?: Record<string, unknown> };
    try {
      notebook = JSON.parse(notebookContent);
      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        throw new Error('Invalid notebook: missing cells array');
      }
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : 'Failed to parse notebook';
      setError(msg);
      setIsExecuting(false);
      return;
    }

    const client = new JupyterBrowserClient({
      serverUrl: jupyterConfig.serverUrl,
      token: jupyterConfig.token || undefined,
    });

    const codeCells = notebook.cells
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => cell.cell_type === 'code' && getCellSource(cell).trim().length > 0);
    const totalCodeCells = codeCells.length;

    setLiveProgress({ status: 'executing', cellIndex: -1, totalCells: totalCodeCells });

    // Report initial state to server
    await reportProgress('executing', undefined, totalCodeCells);

    const kernelName = initialJupyterNotebook?.kernelName || 'python3';
    const notebookPath = `b4m-notebook-${Date.now()}.ipynb`;

    let session: { id: string; kernel: { id: string } } | null = null;

    try {
      session = await client.startSession(notebookPath, kernelName);
      const kernelId = session.kernel.id;

      let cellsFailed = 0;

      for (let ci = 0; ci < codeCells.length; ci++) {
        if (abortRef.current) break;

        const { cell } = codeCells[ci];
        const code = getCellSource(cell);

        setLiveProgress({ status: 'executing', cellIndex: ci, totalCells: totalCodeCells });

        try {
          const result = await client.executeCell(kernelId, code, 30000);
          cell.outputs = result.outputs;
          cell.execution_count = result.executionCount;

          if (!result.success) {
            cellsFailed++;
            const errMsg = result.error ? `${result.error.ename}: ${result.error.evalue}` : 'Cell execution failed';
            setLiveProgress({ status: 'error', cellIndex: ci, totalCells: totalCodeCells, error: errMsg });
            await reportProgress('failed', ci, totalCodeCells, errMsg);
            setError(errMsg);
            if (storageKey) {
              sessionStorage.setItem(storageKey, JSON.stringify({ error: errMsg }));
            }
            // Stop on first error to match CLI behavior
            break;
          }

          await reportProgress('executing', ci, totalCodeCells);
        } catch (cellErr) {
          cellsFailed++;
          const errMsg = cellErr instanceof Error ? cellErr.message : 'Cell execution failed';
          setLiveProgress({ status: 'error', cellIndex: ci, totalCells: totalCodeCells, error: errMsg });
          await reportProgress('failed', ci, totalCodeCells, errMsg);
          setError(errMsg);
          if (storageKey) {
            sessionStorage.setItem(storageKey, JSON.stringify({ error: errMsg }));
          }
          break;
        }
      }

      if (cellsFailed === 0 && !abortRef.current) {
        setLiveProgress({ status: 'completed', cellIndex: totalCodeCells - 1, totalCells: totalCodeCells });
        await reportProgress('completed', totalCodeCells - 1, totalCodeCells);
        if (storageKey) {
          sessionStorage.setItem(storageKey, JSON.stringify({ completed: true }));
        }
      }
    } catch (err) {
      const errMsg =
        err instanceof JupyterBrowserError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to connect to Jupyter server';
      setError(errMsg);
      setLiveProgress({ status: 'failed', error: errMsg });
      await reportProgress('failed', undefined, totalCodeCells, errMsg);
      if (storageKey) {
        sessionStorage.setItem(storageKey, JSON.stringify({ error: errMsg }));
      }
    } finally {
      if (session) {
        try {
          await client.stopSession(session.id);
        } catch {
          // Ignore cleanup errors
        }
      }
      setIsExecuting(false);
    }
  };

  const handleCliExecute = async () => {
    if (!sessionId || !notebookContent) return;

    setIsExecuting(true);
    setError(null);

    try {
      const response = await api.post('/api/jupyter/execute', {
        notebookJson: notebookContent,
        sessionId,
        questId: messageId,
        kernelName: initialJupyterNotebook?.kernelName || 'python3',
      });

      if (response.data.sent) {
        setExecutionStarted(true);
        setLiveProgress({ status: 'executing' });
        if (storageKey) {
          sessionStorage.setItem(storageKey, JSON.stringify({ started: true }));
        }
      }
    } catch (err: unknown) {
      const errorMessage = isAxiosError(err)
        ? err.response?.data?.error || err.response?.data?.hint || err.message
        : err instanceof Error
          ? err.message
          : 'Failed to start execution';
      setError(errorMessage);
      if (storageKey) {
        sessionStorage.setItem(storageKey, JSON.stringify({ error: errorMessage }));
      }
    } finally {
      setIsExecuting(false);
    }
  };

  const handleExecute = async () => {
    const jupyterConfig = getStoredJupyterConfig();
    if (jupyterConfig?.serverUrl) {
      await handleBrowserExecute();
    } else {
      await handleCliExecute();
    }
  };

  // Merge initial state with live progress
  const status = liveProgress.status ?? initialJupyterNotebook?.status ?? (executionStarted ? 'executing' : 'pending');
  const cellCount = liveProgress.totalCells ?? initialJupyterNotebook?.cellCount ?? 0;
  const executedCells =
    liveProgress.cellIndex !== undefined ? liveProgress.cellIndex + 1 : (initialJupyterNotebook?.executedCells ?? 0);
  const lastError = liveProgress.error ?? initialJupyterNotebook?.lastError ?? error;

  if (!notebookContent) {
    return null;
  }

  // Show completion state
  if (status === 'completed') {
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'success.softBg' }}>
        <Typography level="body-sm" sx={{ color: 'success.main', display: 'flex', alignItems: 'center', gap: 1 }}>
          <CheckCircleOutline sx={{ fontSize: 16 }} />
          Notebook executed successfully ({executedCells}/{cellCount} cells)
        </Typography>
      </Box>
    );
  }

  // Show failed state
  if (status === 'failed') {
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'danger.softBg' }}>
        <Typography level="body-sm" sx={{ color: 'danger.main', display: 'flex', alignItems: 'center', gap: 1 }}>
          <ErrorOutline sx={{ fontSize: 16 }} />
          Notebook execution failed: {lastError || 'Unknown error'}
        </Typography>
        <Button
          size="sm"
          variant="outlined"
          color="danger"
          onClick={handleExecute}
          disabled={isExecuting}
          sx={{ mt: 1 }}
        >
          Retry Execution
        </Button>
      </Box>
    );
  }

  // Show executing state with progress
  if (status === 'executing' || executionStarted) {
    const progress = cellCount > 0 ? Math.round((executedCells / cellCount) * 100) : 0;
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'primary.softBg' }}>
        <Typography level="body-sm" sx={{ color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size="sm" sx={{ '--CircularProgress-size': '16px' }} />
          Executing notebook... ({executedCells}/{cellCount || '?'} cells, {progress}%)
        </Typography>
        {lastError && (
          <Typography level="body-xs" sx={{ mt: 0.5, color: 'warning.main' }}>
            Last error: {lastError}
          </Typography>
        )}
      </Box>
    );
  }

  // Show error state
  if (error) {
    return (
      <Box sx={{ mt: 2, p: 1.5, borderRadius: 'sm', bgcolor: 'danger.softBg' }}>
        <Typography level="body-sm" sx={{ color: 'danger.main', mb: 1 }}>
          {error}
        </Typography>
        <Button size="sm" variant="outlined" color="danger" onClick={handleExecute} disabled={isExecuting}>
          {isExecuting ? 'Starting...' : 'Try Again'}
        </Button>
      </Box>
    );
  }

  const hasJupyterConfig = !!getStoredJupyterConfig()?.serverUrl;

  // Show execute button
  return (
    <Box
      sx={{
        mt: 2,
        p: 1.5,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        border: '1px solid',
        borderColor: 'primary.outlinedBorder',
      }}
    >
      <Typography level="body-sm" sx={{ mb: 1.5, fontWeight: 'md' }}>
        Run this notebook locally with Jupyter
      </Typography>
      {!hasJupyterConfig && (
        <Typography level="body-xs" sx={{ mb: 1.5, color: 'text.secondary' }}>
          Configure your Jupyter server in Settings to run notebooks directly from the browser, or use the B4M CLI.
        </Typography>
      )}
      <Button
        size="sm"
        variant="solid"
        color="primary"
        onClick={handleExecute}
        disabled={isExecuting}
        startDecorator={isExecuting ? <CircularProgress size="sm" /> : <PlayArrow sx={{ fontSize: 16 }} />}
        data-testid="notebook-execute-btn"
      >
        {isExecuting ? 'Executing...' : 'Execute Locally'}
      </Button>
    </Box>
  );
};

export default NotebookExecutionButtons;
