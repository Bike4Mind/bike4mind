import React from 'react';
import { Box, Button, Drawer, IconButton, Sheet, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ArticleIcon from '@mui/icons-material/Article';
import { toast } from 'sonner';
import type { DlqListedMessage, DlqMessage, DlqQueueInfo, DlqReplaySafety } from '@client/app/hooks/data/dlqManagement';
import { StatusChip } from '@client/app/components/admin/shared';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { formatDuration, formatExpiresIn, getDlqExpiry } from './dlqExpiry';

export const REPLAY_CHIP: Record<DlqReplaySafety, { tone: AdminStatusTone; label: string }> = {
  safe: { tone: 'good', label: 'Safe to replay' },
  'side-effects': { tone: 'warn', label: 'Replay has side effects' },
  unsafe: { tone: 'bad', label: 'Unsafe to replay' },
};

// A class the server knows but this bundle does not (e.g. deployed ahead of the client) reads as unsafe.
export const UNKNOWN_REPLAY_CHIP = { tone: 'bad', label: 'Replay safety unknown' } as const;

const QueueHint: React.FC<{ queue: DlqQueueInfo }> = ({ queue }) => {
  const chip = queue.replay ? (REPLAY_CHIP[queue.replay] ?? UNKNOWN_REPLAY_CHIP) : undefined;
  return (
    <Stack spacing={0.5} sx={{ pt: 0.5 }} data-testid="dlq-queue-hint">
      <Typography level="body-sm">{queue.description}</Typography>
      {chip && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <StatusChip tone={chip.tone} label={chip.label} data-testid="dlq-queue-hint-replay" />
          {queue.replayNote && <Typography level="body-sm">{queue.replayNote}</Typography>}
        </Stack>
      )}
      {queue.owner && <Typography level="body-xs">Owner: {queue.owner}</Typography>}
    </Stack>
  );
};

export const DlqMessageDrawer: React.FC<{
  message: DlqMessage | DlqListedMessage | null;
  /** The message's queue; absent while the queue list is loading or failed. */
  queue?: DlqQueueInfo;
  open: boolean;
  onClose: () => void;
}> = ({ message, queue, open, onClose }) => {
  if (!message) return null;

  const expiry = getDlqExpiry(message.sentTimestamp, queue?.messageRetentionSeconds);
  const entity = 'entity' in message ? message.entity : null;

  const formatBody = (body: string) => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.body);
      toast('Message body copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <Drawer anchor="right" open={open} onClose={onClose} size="lg">
      <Sheet sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography level="title-lg">Message details</Typography>
          <IconButton onClick={onClose} aria-label="Close" data-testid="dlq-drawer-close">
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack spacing={2}>
          {queue && (
            <Box data-testid="dlq-drawer-queue">
              <Typography level="body-sm" fontWeight="bold">
                {queue.owner ?? queue.displayName}
              </Typography>
              <Typography level="body-sm">Queue: {queue.displayName}</Typography>
              {queue.description !== undefined && <QueueHint queue={queue} />}
            </Box>
          )}

          {entity && (
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                {entity.type}
              </Typography>
              <Typography
                level="body-sm"
                sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                data-testid="dlq-drawer-entity"
              >
                {entity.id}
              </Typography>
            </Box>
          )}

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Message ID
            </Typography>
            <Typography level="body-sm" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {message.messageId}
            </Typography>
          </Box>

          {message.sentTimestamp && (
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                Sent at
              </Typography>
              <Typography level="body-sm">{new Date(parseInt(message.sentTimestamp, 10)).toLocaleString()}</Typography>
            </Box>
          )}

          {message.logsUrl && (
            <Button
              component="a"
              href={message.logsUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="outlined"
              startDecorator={<ArticleIcon />}
              sx={{ alignSelf: 'flex-start' }}
              data-testid="dlq-drawer-logs"
            >
              View consumer logs
            </Button>
          )}
          {expiry && (
            <Box>
              <Typography level="body-sm" fontWeight="bold">
                Age / Expires in
              </Typography>
              <Typography level="body-sm" color={expiry.warn ? 'warning' : undefined} data-testid="dlq-drawer-expiry">
                {expiry.remainingMs === null
                  ? `${formatDuration(expiry.ageMs)} old`
                  : `${formatDuration(expiry.ageMs)} old, expires in ${formatExpiresIn(expiry)}`}
              </Typography>
            </Box>
          )}

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Receive count
            </Typography>
            <Typography level="body-sm">{message.approximateReceiveCount ?? 'N/A'}</Typography>
          </Box>

          <Box>
            <Typography level="body-sm" fontWeight="bold">
              Failure reason
            </Typography>
            <Typography level="body-sm" sx={{ wordBreak: 'break-word' }} data-testid="dlq-failure-reason">
              {message.failure?.errorMessage ?? 'Unknown'}
            </Typography>
            <StatusChip
              tone="neutral"
              label={message.failure?.category ?? 'Unknown'}
              data-testid="dlq-failure-category"
            />
          </Box>

          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography level="body-sm" fontWeight="bold">
                Message body
              </Typography>
              <IconButton size="sm" onClick={handleCopy} aria-label="Copy message body" data-testid="dlq-copy-body">
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Sheet
              variant="soft"
              sx={{
                p: 1.5,
                borderRadius: 'sm',
                maxHeight: 400,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {formatBody(message.body)}
            </Sheet>
          </Box>
        </Stack>
      </Sheet>
    </Drawer>
  );
};
