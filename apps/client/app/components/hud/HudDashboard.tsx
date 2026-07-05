import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Card, Chip, Divider, Input, Sheet, Stack, Typography } from '@mui/joy';
import FolderIcon from '@mui/icons-material/Folder';
import DescriptionIcon from '@mui/icons-material/Description';
import TerminalIcon from '@mui/icons-material/Terminal';
import CircleIcon from '@mui/icons-material/Circle';
import { useWebsocket, ReadyState } from '@client/app/contexts/WebsocketContext';
import type { IKeepCommandResultAction } from '@bike4mind/common';

interface ActivityEntry {
  id: string;
  timestamp: Date;
  type: 'sent' | 'received' | 'error';
  message: string;
}

interface CommandResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export default function HudDashboard() {
  const { sendJsonMessage, subscribeToAction, readyState } = useWebsocket();
  const [filePath, setFilePath] = useState('');
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [lastResult, setLastResult] = useState<CommandResult | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(new Set());
  const activityEndRef = useRef<HTMLDivElement>(null);

  const isConnected = readyState === ReadyState.OPEN;

  // Subscribe to keep_command_result messages from the server relay
  useEffect(() => {
    const unsubscribe = subscribeToAction('keep_command_result', async msg => {
      const data = msg as unknown as IKeepCommandResultAction;
      const { requestId, success, result, error } = data;

      setPendingRequests(prev => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });

      const entry: ActivityEntry = {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        type: success ? 'received' : 'error',
        message: success ? `Result received for ${requestId.slice(0, 8)}...` : `Error: ${error || 'Unknown error'}`,
      };
      setActivity(prev => [...prev, entry]);
      setLastResult({ requestId, success, result, error });
    });

    return unsubscribe;
  }, [subscribeToAction]);

  // Auto-scroll activity feed
  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activity]);

  const addActivity = useCallback((type: ActivityEntry['type'], message: string) => {
    setActivity(prev => [...prev, { id: crypto.randomUUID(), timestamp: new Date(), type, message }]);
  }, []);

  const sendCommand = useCallback(
    (commandType: 'read_file' | 'list_directory') => {
      if (!filePath.trim()) return;

      const requestId = crypto.randomUUID();
      setPendingRequests(prev => new Set(prev).add(requestId));
      addActivity('sent', `${commandType}: ${filePath}`);

      const message = {
        action: 'keep_command_request' as const,
        commandType,
        params: { path: filePath.trim() },
        requestId,
      };
      console.log('[HUD] Sending keep_command_request:', message);
      sendJsonMessage(message as Parameters<typeof sendJsonMessage>[0]);
      console.log('[HUD] sendJsonMessage called');
    },
    [filePath, sendJsonMessage, addActivity]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Guess intent from path: trailing '/' means list_directory, else read_file
        const cmd = filePath.trim().endsWith('/') ? 'list_directory' : 'read_file';
        sendCommand(cmd);
      }
    },
    [filePath, sendCommand]
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 2,
        p: 2,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Stack direction="row" alignItems="center" gap={1.5}>
          <TerminalIcon sx={{ fontSize: 28 }} />
          <Typography level="h3">The Keep</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Local Agent HUD
          </Typography>
        </Stack>
        <Chip
          size="sm"
          variant="soft"
          color={isConnected ? 'success' : 'danger'}
          startDecorator={<CircleIcon sx={{ fontSize: 10 }} />}
          data-testid="keep-status-chip"
        >
          {isConnected ? 'Connected' : 'Disconnected'}
        </Chip>
      </Stack>

      <Divider />

      {/* Command Panel */}
      <Card variant="outlined" data-testid="keep-command-panel">
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Command Panel
        </Typography>
        <Stack direction="row" gap={1}>
          <Input
            placeholder="Enter file or directory path..."
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            onKeyDown={handleKeyDown}
            sx={{ flex: 1 }}
            data-testid="keep-path-input"
          />
          <Button
            variant="solid"
            color="primary"
            startDecorator={<DescriptionIcon />}
            onClick={() => sendCommand('read_file')}
            disabled={!isConnected || !filePath.trim()}
            loading={pendingRequests.size > 0}
            data-testid="keep-read-file-btn"
          >
            Read File
          </Button>
          <Button
            variant="solid"
            color="neutral"
            startDecorator={<FolderIcon />}
            onClick={() => sendCommand('list_directory')}
            disabled={!isConnected || !filePath.trim()}
            loading={pendingRequests.size > 0}
            data-testid="keep-list-dir-btn"
          >
            List Directory
          </Button>
        </Stack>
      </Card>

      {/* Main content area: Activity Feed + Result Display */}
      <Box sx={{ display: 'flex', flex: 1, gap: 2, minHeight: 0 }}>
        {/* Activity Feed (combat log) */}
        <Card
          variant="outlined"
          sx={{ flex: '0 0 320px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          data-testid="keep-activity-feed"
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Activity Feed
          </Typography>
          <Sheet
            variant="soft"
            sx={{
              flex: 1,
              overflow: 'auto',
              borderRadius: 'sm',
              p: 1,
              fontFamily: 'monospace',
              fontSize: 'xs',
            }}
          >
            {activity.length === 0 && (
              <Typography level="body-xs" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                No activity yet. Send a command to get started.
              </Typography>
            )}
            {activity.map(entry => (
              <Box key={entry.id} sx={{ mb: 0.5 }}>
                <Typography
                  level="body-xs"
                  component="span"
                  sx={{
                    color:
                      entry.type === 'sent' ? 'primary.500' : entry.type === 'error' ? 'danger.500' : 'success.500',
                    fontFamily: 'monospace',
                  }}
                >
                  [{entry.timestamp.toLocaleTimeString()}]{' '}
                  {entry.type === 'sent' ? '>>>' : entry.type === 'error' ? '!!!' : '<<<'} {entry.message}
                </Typography>
              </Box>
            ))}
            <div ref={activityEndRef} />
          </Sheet>
        </Card>

        {/* Result Display */}
        <Card
          variant="outlined"
          sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          data-testid="keep-result-display"
        >
          <Typography level="title-sm" sx={{ mb: 1 }}>
            Result
          </Typography>
          <Sheet
            variant="soft"
            sx={{
              flex: 1,
              overflow: 'auto',
              borderRadius: 'sm',
              p: 1.5,
              fontFamily: 'monospace',
              fontSize: 'sm',
            }}
          >
            {!lastResult && (
              <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                Results from Keep commands will appear here.
              </Typography>
            )}
            {lastResult && !lastResult.success && (
              <Typography level="body-sm" sx={{ color: 'danger.500' }}>
                Error: {lastResult.error}
              </Typography>
            )}
            {lastResult?.success && renderResult(lastResult.result)}
          </Sheet>
        </Card>
      </Box>
    </Box>
  );
}

/** Render the result based on its shape */
function renderResult(result: unknown) {
  if (!result) return null;

  // File content result
  if (typeof result === 'object' && result !== null && 'content' in result) {
    const { content, path } = result as { content: string; path: string };
    return (
      <Box>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', mb: 1 }}>
          {path}
        </Typography>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</pre>
      </Box>
    );
  }

  // Directory listing result
  if (Array.isArray(result)) {
    return (
      <Stack gap={0.25}>
        {result.map((entry: { name: string; isDirectory: boolean }, i: number) => (
          <Stack key={i} direction="row" alignItems="center" gap={0.5}>
            {entry.isDirectory ? (
              <FolderIcon sx={{ fontSize: 16, color: 'primary.400' }} />
            ) : (
              <DescriptionIcon sx={{ fontSize: 16, color: 'neutral.400' }} />
            )}
            <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
              {entry.name}
              {entry.isDirectory ? '/' : ''}
            </Typography>
          </Stack>
        ))}
      </Stack>
    );
  }

  // Fallback: JSON dump
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(result, null, 2)}</pre>
  );
}
