import { useState } from 'react';
import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatChildWaiting, ChatMessage } from '@shared/chat';
import { ChildReportCard, workspaceLine } from './ChildReportCard';
import type { ChildCard, ChildCardState } from './childCardLayout';
import { LinkifiedText } from './ExternalLink';
import { BranchIcon, ChevronIcon } from './icons';
import { displayText } from './relayRows';
import { SessionLink } from './SessionLink';

const STATE_LABEL: Record<ChildCardState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  failed: 'Stopped',
  finished: 'Finished',
};

const STATE_COLOR = {
  'needs-you': 'warning',
  working: 'primary',
  failed: 'danger',
  finished: 'neutral',
} as const satisfies Record<ChildCardState, string>;

/** The one line that says what a waiting child wants from the user. */
export function waitingLine(waiting: ChatChildWaiting): string {
  if (waiting.reason === 'decision') return 'Waiting on your decision';
  if (waiting.reason === 'message') return 'Holding a message for you to release';
  return waiting.summary ? `Approve: ${waiting.summary}` : 'Waiting on your approval';
}

/**
 * The sessions this conversation started, one live card each, in place of a notice per wait and a
 * card per report. Drawn where the latest of those notices would have been. See childCardLayout.ts.
 */
export function ChildSessionCards({ cards }: { cards: readonly ChildCard[] }) {
  return (
    <Stack spacing={1} data-testid="child-session-cards">
      {cards.map(card => (
        <ChildSessionCard key={card.sessionId} card={card} />
      ))}
    </Stack>
  );
}

function ChildSessionCard({ card }: { card: ChildCard }) {
  const [expanded, setExpanded] = useState(false);
  const settled = card.state === 'finished' || card.state === 'failed';
  const where = settled && card.report ? workspaceLine(card.report.report) : null;
  // Settled: what its report said. Working: nothing to say beyond the chip, the ask is answered.
  const headline = card.waiting
    ? waitingLine(card.waiting)
    : settled && card.report
      ? displayText(card.report.message)
      : undefined;

  return (
    <Sheet
      variant="soft"
      color={card.state === 'needs-you' ? 'warning' : card.state === 'failed' ? 'danger' : 'neutral'}
      sx={{
        px: 2,
        py: 1.25,
        borderRadius: 'md',
        opacity: card.state === 'finished' ? 0.65 : 1,
        transition: 'opacity 160ms ease-out',
        '&:hover, &:focus-within': { opacity: 1 },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
      data-testid="child-session-card"
      data-session-id={card.sessionId}
      data-state={card.state}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Chip size="sm" variant="soft" color={STATE_COLOR[card.state]} data-testid="child-session-card-state">
          {STATE_LABEL[card.state]}
        </Chip>
        <Typography level="title-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>
          <SessionLink sessionId={card.sessionId} testId="child-session-card-open-link">
            {card.title ?? 'A session you started'}
          </SessionLink>
        </Typography>
        {card.asks > 1 && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            title={`It has stopped to ask ${card.asks} times`}
            data-testid="child-session-card-asks"
          >
            {`${card.asks} asks`}
          </Typography>
        )}
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setExpanded(open => !open)}
          aria-label={expanded ? 'Hide its history' : 'Show its history'}
          aria-expanded={expanded}
          data-testid="child-session-card-history-btn"
        >
          <ChevronIcon open={expanded} />
        </IconButton>
      </Box>
      {headline && (
        <Typography
          level="body-sm"
          sx={{ mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          data-testid="child-session-card-headline"
        >
          <LinkifiedText text={headline} />
        </Typography>
      )}
      {where && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          startDecorator={<BranchIcon />}
          sx={{ mt: 0.5, fontFamily: 'code', wordBreak: 'break-all', '& svg': { width: 12, height: 12 } }}
          data-testid="child-session-card-workspace"
        >
          {where}
        </Typography>
      )}
      {expanded && (
        <Stack spacing={0.75} sx={{ mt: 1 }} data-testid="child-session-card-history">
          {card.history.map(message => (
            <HistoryEntry key={message.id} message={message} />
          ))}
        </Stack>
      )}
    </Sheet>
  );
}

/** One notice or report from the card's history, as it was when it arrived. */
function HistoryEntry({ message }: { message: ChatMessage }) {
  if (message.childReport) return <ChildReportCard message={message} report={message.childReport} />;
  const at = new Date(message.createdAt);
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }} data-testid="child-session-card-history-entry">
      <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
        {Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Typography>
      <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <LinkifiedText text={message.childWaiting ? waitingLine(message.childWaiting) : displayText(message)} />
      </Typography>
    </Box>
  );
}
