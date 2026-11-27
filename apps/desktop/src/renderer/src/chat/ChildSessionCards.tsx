import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { isUnfinishedOutcome } from '@shared/agentOutcome';
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

const DOT_COLOR = {
  'needs-you': 'warning.400',
  working: 'primary.400',
  failed: 'danger.400',
  finished: 'success.400',
} as const satisfies Record<ChildCardState, string>;

/** The one line that says what a waiting child wants from the user. */
export function waitingLine(waiting: ChatChildWaiting): string {
  if (waiting.reason === 'decision') return 'Waiting on your decision';
  if (waiting.reason === 'message') return 'Holding a message for you to release';
  return waiting.summary ? `Approve: ${waiting.summary}` : 'Waiting on your approval';
}

/** A card that still wants the user keeps its full size; everything else is one line in the list. */
function wantsAttention(card: ChildCard): boolean {
  return !card.gone && (card.state === 'needs-you' || card.state === 'failed');
}

/**
 * What a Stopped child's last report said, when that report was a failure too. The state follows
 * the live session, which can be newer than the last report this thread got, so a stale
 * "has finished." is not shown under a Stopped chip. Its history keeps it.
 */
function settledHeadline(card: ChildCard): string | undefined {
  if (!card.report || card.state !== 'failed') return undefined;
  return isUnfinishedOutcome(card.report.report.outcome) ? displayText(card.report.message) : undefined;
}

/**
 * The sessions this conversation started, drawn where the latest of their notices would have been
 * (see childCardLayout.ts). A child that wants the user gets a full card; working and finished
 * children share one compact list; archived and deleted ones fold behind a count in that list.
 */
export function ChildSessionCards({ cards }: { cards: readonly ChildCard[] }) {
  const attention = cards.filter(wantsAttention);
  const quiet = cards.filter(card => !card.gone && !wantsAttention(card));
  const gone = cards.filter(card => card.gone);

  return (
    <Stack spacing={1} data-testid="child-session-cards">
      {attention.map(card => (
        <ChildSessionCard key={card.sessionId} card={card} />
      ))}
      {(quiet.length > 0 || gone.length > 0) && <ChildSessionList quiet={quiet} gone={gone} />}
    </Stack>
  );
}

function ChildSessionCard({ card }: { card: ChildCard }) {
  const [expanded, setExpanded] = useState(false);
  const where = card.report ? workspaceLine(card.report.report) : null;
  const headline = card.waiting ? waitingLine(card.waiting) : settledHeadline(card);

  return (
    <Sheet
      variant="soft"
      color={card.state === 'needs-you' ? 'warning' : 'danger'}
      sx={{ px: 2, py: 1.25, borderRadius: 'md' }}
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
        <ExpandButton expanded={expanded} onToggle={() => setExpanded(open => !open)} testId="child-session-card-history-btn" />
      </Box>
      {headline && <Headline text={headline} testId="child-session-card-headline" />}
      {card.state === 'failed' && where && <Workspace text={where} testId="child-session-card-workspace" />}
      {expanded && <History card={card} testId="child-session-card-history" />}
    </Sheet>
  );
}

function ChildSessionList({ quiet, gone }: { quiet: readonly ChildCard[]; gone: readonly ChildCard[] }) {
  const [showGone, setShowGone] = useState(false);
  const working = quiet.filter(card => card.state === 'working').length;
  const finished = quiet.length - working;
  const summary = [
    `${quiet.length} sub-session${quiet.length === 1 ? '' : 's'}`,
    ...(working > 0 ? [`${working} working`] : []),
    ...(finished > 0 ? [`${finished} finished`] : []),
  ].join(' · ');

  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', overflow: 'hidden', '& > * + *': { borderTop: '1px solid', borderColor: 'divider' } }}
      data-testid="child-session-list"
    >
      {quiet.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75 }}>
          <Box sx={{ display: 'flex', gap: 0.5 }} aria-hidden>
            {quiet.map(card => (
              <StateDot key={card.sessionId} card={card} />
            ))}
          </Box>
          <Typography level="body-sm" textColor="text.secondary" noWrap data-testid="child-session-list-summary">
            {summary}
          </Typography>
        </Box>
      )}
      {quiet.map(card => (
        <ChildSessionRow key={card.sessionId} card={card} />
      ))}
      {gone.length > 0 && (
        <Box>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setShowGone(open => !open)}
            aria-expanded={showGone}
            sx={{ fontWeight: 'md', width: '100%', justifyContent: 'flex-start', borderRadius: 0 }}
            data-testid="child-session-gone-toggle"
          >
            {`${showGone ? 'Hide' : 'Show'} ${gone.length} archived or deleted`}
          </Button>
          {showGone && (
            <Box
              sx={{ '& > *': { borderTop: '1px solid', borderColor: 'divider' } }}
              data-testid="child-session-gone-list"
            >
              {gone.map(card => (
                <ChildSessionRow key={card.sessionId} card={card} />
              ))}
            </Box>
          )}
        </Box>
      )}
    </Sheet>
  );
}

function ChildSessionRow({ card }: { card: ChildCard }) {
  const [expanded, setExpanded] = useState(false);
  const meta = card.state === 'working' ? 'working' : card.report?.report.headSha?.slice(0, 10);

  return (
    <Box
      sx={{ px: 1.5, py: 0.75 }}
      data-testid="child-session-row"
      data-session-id={card.sessionId}
      data-state={card.state}
      {...(card.gone ? { 'data-gone': card.gone } : {})}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <StateDot card={card} />
        <Typography
          level="body-sm"
          textColor={card.gone ? 'text.tertiary' : undefined}
          sx={{ flex: 1, minWidth: 0, fontWeight: card.gone ? 'md' : 'lg' }}
          noWrap
          title={STATE_LABEL[card.state]}
        >
          {card.gone === 'deleted' ? (
            (card.title ?? 'A session you started')
          ) : (
            <SessionLink sessionId={card.sessionId} testId="child-session-row-open-link">
              {card.title ?? 'A session you started'}
            </SessionLink>
          )}
        </Typography>
        {card.gone ? (
          <Chip size="sm" variant="outlined" color="neutral" data-testid="child-session-row-gone">
            {card.gone}
          </Chip>
        ) : (
          meta && (
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              sx={{ fontFamily: 'code', flexShrink: 0 }}
              data-testid="child-session-row-meta"
            >
              {meta}
            </Typography>
          )
        )}
        <ExpandButton expanded={expanded} onToggle={() => setExpanded(open => !open)} testId="child-session-row-expand-btn" />
      </Box>
      {expanded && (
        // Its reports carry their own headline and workspace line, so the history is the whole detail.
        <Box sx={{ pl: 2.5 }} data-testid="child-session-row-detail">
          <History card={card} testId="child-session-row-history" />
        </Box>
      )}
    </Box>
  );
}

function StateDot({ card }: { card: ChildCard }) {
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        bgcolor: card.gone ? 'neutral.500' : DOT_COLOR[card.state],
      }}
    />
  );
}

function ExpandButton({ expanded, onToggle, testId }: { expanded: boolean; onToggle: () => void; testId: string }) {
  return (
    <IconButton
      size="sm"
      variant="plain"
      color="neutral"
      onClick={onToggle}
      aria-label={expanded ? 'Hide its history' : 'Show its history'}
      aria-expanded={expanded}
      data-testid={testId}
    >
      <ChevronIcon open={expanded} />
    </IconButton>
  );
}

function Headline({ text, testId }: { text: string; testId: string }) {
  return (
    <Typography level="body-sm" sx={{ mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} data-testid={testId}>
      <LinkifiedText text={text} />
    </Typography>
  );
}

function Workspace({ text, testId }: { text: string; testId: string }) {
  return (
    <Typography
      level="body-xs"
      textColor="text.tertiary"
      startDecorator={<BranchIcon />}
      sx={{ mt: 0.5, fontFamily: 'code', wordBreak: 'break-all', '& svg': { width: 12, height: 12 } }}
      data-testid={testId}
    >
      {text}
    </Typography>
  );
}

function History({ card, testId }: { card: ChildCard; testId: string }) {
  return (
    <Stack spacing={0.75} sx={{ mt: 1 }} data-testid={testId}>
      {card.history.map(message => (
        <HistoryEntry key={message.id} message={message} />
      ))}
    </Stack>
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
