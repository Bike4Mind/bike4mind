import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatToolCall, ChatToolStatus } from '@shared/chat';

const STATUS_COLOR: Record<ChatToolStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  running: 'neutral',
  done: 'success',
  error: 'danger',
  denied: 'warning',
};

/** The argument worth showing next to the tool name - almost always what it acted on. */
function summarizeInput(call: ChatToolCall): string {
  const input = call.input ?? {};
  const interesting = input.path ?? input.pattern ?? input.command;
  return typeof interesting === 'string' ? interesting : '';
}

function ToolCall({ call }: { call: ChatToolCall }) {
  const summary = summarizeInput(call);

  return (
    <Box
      component="details"
      sx={{ borderRadius: 'sm', bgcolor: 'background.level2', px: 1, py: 0.5 }}
      data-testid="chat-tool-call"
    >
      <Stack component="summary" direction="row" spacing={1} alignItems="center" sx={{ cursor: 'pointer' }}>
        {call.status === 'running' ? (
          <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
        ) : (
          <Chip size="sm" variant="soft" color={STATUS_COLOR[call.status]} data-testid="chat-tool-status">
            {call.status}
          </Chip>
        )}
        <Typography level="body-xs" fontFamily="monospace">
          {call.name}
        </Typography>
        {summary && (
          <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ minWidth: 0 }}>
            {summary}
          </Typography>
        )}
      </Stack>

      <Box sx={{ pt: 0.75 }}>
        <Typography
          level="body-xs"
          fontFamily="monospace"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto' }}
          textColor={call.error ? 'danger.400' : 'text.secondary'}
        >
          {call.error ?? call.preview ?? 'Running...'}
        </Typography>
      </Box>
    </Box>
  );
}

export function ToolCallList({ calls }: { calls: ChatToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <Stack spacing={0.5} sx={{ mb: 1 }}>
      {calls.map(call => (
        <ToolCall key={call.id} call={call} />
      ))}
    </Stack>
  );
}
