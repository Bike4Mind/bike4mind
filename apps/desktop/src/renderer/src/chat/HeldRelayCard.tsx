import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatHeldRelay, ChatRelayHoldReason } from '@shared/chat';
import { contentColumnSx } from './layout';
import { SessionLink } from './SessionLink';

const REASONS: Record<ChatRelayHoldReason, string> = {
  'other-project': "It comes from another project, so it could reach folders that conversation can't.",
  'looser-mode': 'This conversation can do more without asking than the sender.',
};

/** Past this a message starts collapsed behind "Show more". */
const COLLAPSE_CHARS = 200;
const COLLAPSE_LINES = 3;

function HeldRelayRow({
  held,
  onResolve,
  onOpenSession,
}: {
  held: ChatHeldRelay;
  onResolve: (heldId: string, deliver: boolean) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { relay } = held;
  const long = held.text.length > COLLAPSE_CHARS || held.text.split('\n').length > COLLAPSE_LINES;

  const resolve = async (deliver: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(held.id, deliver);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve this message');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      variant="outlined"
      color="warning"
      sx={{ borderRadius: 'md', p: 1.25 }}
      data-testid="held-relay-card"
      data-held-id={held.id}
      data-reason={held.reason}
    >
      <Stack spacing={0.75}>
        <Typography level="title-sm">
          Message from{' '}
          <SessionLink sessionId={relay.fromSessionId} testId="held-relay-sender-link" onOpen={onOpenSession}>
            {relay.fromTitle || 'another session'}
          </SessionLink>
          {relay.fromProject ? ` in ${relay.fromProject}` : ''}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {REASONS[held.reason]}
        </Typography>
        {relay.notify && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="held-relay-notify-note">
            Delivering also lets {relay.fromTitle || 'the sender'} read this conversation when the turn ends.
          </Typography>
        )}
        <Typography
          level="body-sm"
          data-testid="held-relay-text"
          sx={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            ...(long &&
              !expanded && {
                display: '-webkit-box',
                WebkitLineClamp: COLLAPSE_LINES,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }),
          }}
        >
          {held.text}
        </Typography>
        {long && (
          <Box>
            <Typography
              level="body-xs"
              sx={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => setExpanded(current => !current)}
              data-testid="held-relay-expand-toggle"
            >
              {expanded ? 'Show less' : 'Show more'}
            </Typography>
          </Box>
        )}
        {error && (
          <Alert size="sm" color="danger" variant="soft" data-testid="held-relay-error">
            {error}
          </Alert>
        )}
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={busy}
            onClick={() => void resolve(false)}
            data-testid="held-relay-decline-btn"
          >
            Decline
          </Button>
          <Button
            size="sm"
            variant="solid"
            color="primary"
            disabled={busy}
            onClick={() => void resolve(true)}
            data-testid="held-relay-deliver-btn"
          >
            Deliver
          </Button>
        </Stack>
      </Stack>
    </Sheet>
  );
}

/**
 * Messages another conversation sent here that are waiting on the user. Nothing reaches the
 * model until one is delivered: the row says why it was held, and the choice is the user's.
 */
export function HeldRelayCard({
  held,
  onResolve,
  onOpenSession,
}: {
  held: readonly ChatHeldRelay[];
  onResolve: (heldId: string, deliver: boolean) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
  if (held.length === 0) return null;
  return (
    <Stack spacing={0.75} sx={{ ...contentColumnSx, pt: 1.5 }} data-testid="held-relay-list">
      {held.map(entry => (
        <HeldRelayRow key={entry.id} held={entry} onResolve={onResolve} onOpenSession={onOpenSession} />
      ))}
    </Stack>
  );
}
