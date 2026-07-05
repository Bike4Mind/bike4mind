/**
 * NotebookExecutionButtons - Execute Jupyter notebook locally via CLI
 * Shown when a message contains generated notebook content
 */

import { Box, Button, CircularProgress, Typography } from '@mui/joy';
import { CheckCircleOutline, ErrorOutline, PlayArrow } from '@mui/icons-material';
import { FC, useState, useEffect } from 'react';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import type { IChatHistoryItem } from '@bike4mind/common';

export interface NotebookExecutionButtonsProps {
  jupyterNotebook?: IChatHistoryItem['jupyterNotebook'];
  notebookContent?: string;
  sessionId?: string;
  messageId?: string;
}

/**
 * Safely parse sessionStorage data with error handling.
 * Returns null if data is corrupted or unparseable.
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
    // Corrupted data - clear it and return null
    if (storageKey) {
      sessionStorage.removeItem(storageKey);
    }
    return null;
  }
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

  // Live progress state updated via WebSocket
  const [liveProgress, setLiveProgress] = useState<{
    status?: string;
    cellIndex?: number;
    totalCells?: number;
    error?: string;
  }>({});

  // Subscribe to WebSocket progress updates
  useEffect(() => {
    if (!messageId || !sessionId) return;

    const unsubscribe = subscribeToAction('jupyter_notebook_progress', async message => {
      // Type guard for the message
      const progressMsg = message as {
        action: string;
        questId?: string;
        sessionId?: string;
        status?: string;
        cellIndex?: number;
        totalCells?: number;
        error?: string;
      };

      // Check if this progress update is for our message/session
      if (progressMsg.questId === messageId || progressMsg.sessionId === sessionId) {
        setLiveProgress({
          status: progressMsg.status,
          cellIndex: progressMsg.cellIndex,
          totalCells: progressMsg.totalCells,
          error: progressMsg.error,
        });

        // Update sessionStorage for persistence across refresh
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
    // storageKey is derived from messageId, but eslint requires it in deps
  }, [messageId, sessionId, subscribeToAction, storageKey]);

  // Merge initial state with live progress
  const status = liveProgress.status ?? initialJupyterNotebook?.status ?? (executionStarted ? 'executing' : 'pending');
  const cellCount = liveProgress.totalCells ?? initialJupyterNotebook?.cellCount ?? 0;
  // Use ?? to handle 0 as a valid value (|| would incorrectly treat 0 as falsy)
  const executedCells =
    liveProgress.cellIndex !== undefined ? liveProgress.cellIndex + 1 : (initialJupyterNotebook?.executedCells ?? 0);
  const lastError = liveProgress.error ?? initialJupyterNotebook?.lastError ?? error;

  // Don't show if no notebook content to execute
  if (!notebookContent) {
    return null;
  }

  const handleExecute = async () => {
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
      <Typography level="body-xs" sx={{ mb: 1.5, color: 'text.secondary' }}>
        Requires B4M CLI connected with Jupyter server running locally
      </Typography>
      <Button
        size="sm"
        variant="solid"
        color="primary"
        onClick={handleExecute}
        disabled={isExecuting}
        startDecorator={isExecuting ? <CircularProgress size="sm" /> : <PlayArrow sx={{ fontSize: 16 }} />}
        data-testid="notebook-execute-btn"
      >
        {isExecuting ? 'Starting...' : 'Execute Locally'}
      </Button>
    </Box>
  );
};

export default NotebookExecutionButtons;
