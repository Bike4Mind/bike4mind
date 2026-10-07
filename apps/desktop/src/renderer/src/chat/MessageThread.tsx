import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { isTurnBudgetStop, lastBoundaryIndex, type ChatMessage, type ChatUsage } from '@shared/chat';
import { ArtifactList } from './ArtifactCard';
import { presentReply } from './codeStream';
import { ReasoningRow } from './ReasoningRow';
import { AttachmentRow } from './Attachments';
import { ChevronIcon } from './icons';
import { contentColumnSx, scrollingColumnHostSx } from './layout';
import { ReplyMarkdown } from './markdown/ReplyMarkdown';
import { displayText, relaySummary } from './relayRows';
import { callsIn, roundsOf } from './replyRounds';
import { describeReplyCost, formatCreditsSpent } from './statusLine';
import { ToolCallList, type MoveCallToBackground, type RespondToApproval } from './ToolCallList';

/** What each budget the agent loop enforces is called in the thread. See isTurnBudgetStop. */
const BUDGET_STOP_LABELS: Record<string, string> = {
  tool_turn_limit: 'Paused after a lot of tool calls',
  turn_time_limit: 'Paused after running a long time',
  tool_stall_limit: 'Paused after repeating the same step',
};

/**
 * Why a reply ended, when that was not simply the model finishing.
 *
 * A budget stop is drawn beside Continue rather than on its own, so the row says "here is what
 * happened and here is what to do about it" - the chip alone read as a dead end, which is
 * exactly what it no longer is.
 */
function StopReasonRow({ reason, onContinue }: { reason?: string; onContinue?: () => void }) {
  if (reason === 'max_tokens') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-truncated-chip">
        Cut off at the length limit
      </Chip>
    );
  }
  if (isTurnBudgetStop(reason)) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
        <Chip size="sm" color="warning" variant="soft" data-testid="chat-tool-limit-chip">
          {BUDGET_STOP_LABELS[reason as string]}
        </Chip>
        {onContinue && (
          <Button size="sm" variant="soft" color="primary" onClick={onContinue} data-testid="chat-continue-reply-btn">
            Continue
          </Button>
        )}
      </Stack>
    );
  }
  // No Continue: the next request would carry the same oversized conversation and fail the same
  // way, and a button that cannot work is worse than no button. Says what to do instead.
  if (reason === 'context_limit') {
    return (
      <Chip size="sm" color="warning" variant="soft" sx={{ mt: 1 }} data-testid="chat-context-limit-chip">
        Stopped - this conversation filled the model's context. Start a new one to carry on.
      </Chip>
    );
  }
  if (reason === 'aborted') {
    return (
      <Chip size="sm" color="neutral" variant="soft" sx={{ mt: 1 }} data-testid="chat-stopped-chip">
        Stopped
      </Chip>
    );
  }
  return null;
}

/**
 * The user's own turn: a right-aligned bubble, narrower than the column so the alignment
 * reads as "mine" at a glance even when the text is long.
 */
function UserTurn({ message, sessionId }: { message: ChatMessage; sessionId: string | null }) {
  const attachments = message.attachments ?? [];
  const skill = message.skill;
  const [expanded, setExpanded] = useState(false);

  return (
    <Stack direction="row" justifyContent="flex-end">
      <Sheet
        variant="soft"
        color="primary"
        sx={{ px: 2, py: 1.25, borderRadius: 'lg', maxWidth: '85%', minWidth: 0 }}
        data-testid="chat-message-user"
      >
        {/* Above the text, matching the composer: what was handed over, then what was asked
            about it. Not removable here - the turn has been sent. */}
        {attachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1 : 0 }}>
            <AttachmentRow sessionId={sessionId} attachments={attachments} />
          </Box>
        )}

        {/* A skill turn shows the INVOCATION, because that is the sentence the user wrote. The
            expanded body is what was sent and stays reachable, folded away: a page of someone
            else's instructions where a one-line prompt belongs makes the thread unreadable, and
            hiding it outright would leave no way to see what the model was actually told. */}
        {skill ? (
          <Stack spacing={0.75} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography level="title-sm" data-testid="chat-message-skill">
                /{skill.name}
                {skill.args ? ` ${skill.args}` : ''}
              </Typography>
              <Chip size="sm" variant="soft" color={skill.source === 'project' ? 'warning' : 'neutral'}>
                {skill.source} skill
              </Chip>
            </Stack>
            <Box>
              <Typography
                level="body-xs"
                sx={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => setExpanded(current => !current)}
                data-testid="chat-message-skill-toggle"
              >
                {expanded ? 'Hide what was sent' : 'Show what was sent'}
              </Typography>
              {expanded && (
                <Typography level="body-xs" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.5 }}>
                  {message.content}
                </Typography>
              )}
            </Box>
          </Stack>
        ) : (
          /* Literal, where a reply is markdown: this is what the user typed, and rendering it
             would change it. In a Code session they type paths and identifiers, and
             some_file_name would come back as some<em>file</em>name with the underscores eaten.
             A reply is a model writing markdown on purpose; this is not. */
          message.content && (
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {message.content}
            </Typography>
          )
        )}
      </Sheet>
    </Stack>
  );
}

/**
 * Marks the cost row for the `:hover` rule on the turn around it. A class rather than a child
 * selector so the rule survives any wrapper that gets put between the two.
 */
const REPLY_COST_CLASS = 'b4m-reply-cost';

/**
 * What this reply cost, read off the usage the message already carries.
 *
 * Quiet until the turn is hovered, and out of the flow while it is: a thread runs to hundreds of
 * replies, and a row that reserved its line would grow every one of them by a line to show a
 * figure nobody is looking at. Sitting in the gap under the turn, it shifts nothing either way.
 *
 * There is no React state here on purpose. Hover tracked in state - here or, far worse, in the
 * thread above - is a render per mouse move across a transcript that can be hundreds of turns
 * long. The parent's `:hover` does the same job for nothing; see AssistantTurn.
 *
 * Nothing at all when the server reported no credits. Absent is not zero - a turn that failed,
 * and every reply stored before this was captured, would otherwise claim to have been free.
 */
function ReplyCost({ usage }: { usage?: ChatUsage }) {
  const credits = formatCreditsSpent(usage);
  if (!credits) return null;

  return (
    <Typography
      level="body-xs"
      textColor="text.tertiary"
      className={REPLY_COST_CLASS}
      // Native, like the turn status line's own split: a Joy tooltip per reply would mount a
      // popper for every turn in the thread to serve the one the pointer is over.
      title={describeReplyCost(usage) ?? undefined}
      sx={{ position: 'absolute', top: '100%', right: 0, mt: 0.5, whiteSpace: 'nowrap' }}
      data-testid="chat-message-cost"
    >
      {credits}
    </Typography>
  );
}

/**
 * The assistant's turn: set flush in the column with no bubble around it.
 *
 * A reply can run for screens, and a container drawn around that much text reads as a wall
 * rather than as prose; the right-aligned user bubble is what separates the two speakers.
 *
 * Nothing here reports that a reply is on its way. The status line under the transcript does
 * that for the whole turn, and a spinner in the thread as well would be the same fact twice.
 *
 * The hover rule for the cost lives here rather than on the row it reveals, because CSS is what
 * keeps it free: see ReplyCost.
 */
function AssistantTurn({
  message,
  onRespond,
  onMove,
  onContinue,
  status,
  live = false,
}: {
  message: ChatMessage;
  onRespond: RespondToApproval;
  /** Absent with no conversation open; the running-command control is then not drawn. */
  onMove?: MoveCallToBackground;
  /** The reply still streaming: its last round may end in code that is still being written. */
  live?: boolean;
  /** Absent unless this is the turn a Continue would resume; see MessageThread. */
  onContinue?: () => void;
  /** What this turn is doing, while it is the one in flight; see MessageThread. */
  status?: ReactNode;
}) {
  const toolCalls = message.toolCalls ?? [];
  const rounds = roundsOf(message);

  return (
    <Box
      sx={{
        minWidth: 0,
        position: 'relative',
        [`& .${REPLY_COST_CLASS}`]: { opacity: 0, pointerEvents: 'none', transition: 'opacity 120ms' },
        [`&:hover .${REPLY_COST_CLASS}`]: { opacity: 1, pointerEvents: 'auto' },
      }}
      data-testid="chat-message-assistant"
    >
      {/* The turn in the order it happened: each round's prose, then the tools that round went
          on to run, then the next round's prose. A reply that touched six files across ten
          rounds is a narrative, and every row piled up after every word is not that narrative. */}
      {rounds.map((round, index) => {
        const streaming = live && index === rounds.length - 1;
        const presented = presentReply(round.text, streaming);
        return (
          // The gap lives here rather than as a blank line inside the text, so a round that ran
          // tools and said nothing does not leave an empty paragraph behind.
          <Box key={index} sx={{ mt: index === 0 ? 0 : 1.5 }} data-testid="chat-message-round">
            {/* Above the prose, because that is where it happened: the model thought, then
                wrote. Never on the round still streaming - the status line is already speaking
                for that one, and this would be its second copy. See ReasoningRow. */}
            {!streaming && round.reasoning && <ReasoningRow reasoning={round.reasoning} />}

            {/* Per round rather than over the whole reply, which is also what keeps a code fence
                from leaking: a block opened in one round cannot swallow the next round's prose,
                because the next round is a parse of its own. */}
            {presented.text.length > 0 && <ReplyMarkdown text={presented.text} />}
            {presented.unfinishedArtifact !== null && (
              <Typography level="body-sm" color="warning" sx={{ mt: 1 }} data-testid="chat-unfinished-artifact">
                {presented.unfinishedArtifact
                  ? `The artifact "${presented.unfinishedArtifact}" was cut off before it was finished, so it was not saved.`
                  : 'An artifact was cut off before it was finished, so it was not saved.'}
              </Typography>
            )}
            <ToolCallList calls={callsIn(round, toolCalls)} onRespond={onRespond} {...(onMove ? { onMove } : {})} />
          </Box>
        );
      })}

      {/* After both, because an artifact is what the turn produced rather than part of how it
          got there. `content` has already had the markup removed, so nothing is shown twice. */}
      <ArtifactList artifacts={message.artifacts ?? []} />

      {message.error && (
        <Alert size="sm" color="danger" variant="soft" sx={{ mt: 1 }} data-testid="chat-message-error">
          {message.error}
        </Alert>
      )}

      <StopReasonRow reason={message.stopReason} onContinue={onContinue} />

      {/* Last, under the reply it describes, which is where the eye already is while a turn
          runs. It lived in the composer before and read as a property of the input box rather
          than of the answer being written. */}
      {status && <Box sx={{ mt: 1 }}>{status}</Box>}

      <ReplyCost {...(message.usage ? { usage: message.usage } : {})} />
    </Box>
  );
}

/**
 * A message the app put in the thread rather than either speaker: a spawned session reporting
 * back to the conversation that started it.
 *
 * Centred and quiet, on neither side of the conversation, because it is neither: drawn as a
 * user bubble it would read as something the user typed, and as an assistant turn as something
 * the model said. Both would be a lie about where the text came from.
 */
function SystemTurn({ message }: { message: ChatMessage }) {
  return (
    <Sheet
      variant="soft"
      color="neutral"
      sx={{ px: 2, py: 1.25, borderRadius: 'md' }}
      data-testid="chat-message-system"
    >
      <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', mb: 0.5 }}>
        From a session you started
      </Typography>
      <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {displayText(message)}
      </Typography>
    </Sheet>
  );
}

/**
 * A message another conversation sent here with session_send.
 *
 * Drawn as a collapsed row rather than as a turn, for the reason a tool call is: it is how this
 * conversation got somewhere, not part of what was said in it. The distinction that matters is
 * from a USER message - these words were written by a model in another session, and a bubble on
 * the user's side of the thread would be a straightforward lie about who said them. So it sits
 * behind the same left rule the tool rows use, names the sender in the summary, and keeps the
 * full text one click away.
 */
function RelayTurn({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ borderLeft: '2px solid', borderColor: 'divider', pl: 1.25 }}>
      <Box
        component="details"
        open={open}
        onToggle={event => setOpen(event.currentTarget.open)}
        data-testid="chat-message-relay"
        data-from={message.relay?.fromSessionId}
      >
        <Stack
          component="summary"
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{
            cursor: 'pointer',
            listStyle: 'none',
            py: 0.25,
            color: 'text.tertiary',
            '&::-webkit-details-marker': { display: 'none' },
            '&:hover': { color: 'text.secondary' },
          }}
          data-testid="chat-message-relay-summary"
        >
          <Typography level="body-xs" textColor="inherit" noWrap sx={{ minWidth: 0 }}>
            {relaySummary(message)}
          </Typography>
          <Box sx={{ display: 'flex', opacity: 0.6 }}>
            <ChevronIcon open={open} />
          </Box>
        </Stack>

        <Typography
          level="body-sm"
          sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', pt: 0.5, pb: 0.5 }}
          textColor="text.secondary"
          data-testid="chat-message-relay-body"
        >
          {displayText(message)}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * The divider a `/clear` or `/compact` left behind.
 *
 * Drawn across the column rather than as a turn, because it is not one: it is the line the model
 * no longer reads past. The wording says that and nothing stronger - nothing was deleted, and a
 * user who reads "cleared" as "gone" would not go looking for the disclosure above it that still
 * holds every message.
 *
 * A compaction's summary is shown in full rather than folded away. It is the only thing the next
 * turn is built on, so what it says - and what it leaves out - is exactly what the user needs to
 * be able to read before they type again.
 */
function BoundaryRow({ message }: { message: ChatMessage }) {
  const compacted = message.boundary?.kind === 'compact';
  const automatic = compacted && message.boundary?.automatic === true;

  return (
    <Stack
      spacing={1}
      data-testid="chat-boundary"
      data-boundary-kind={message.boundary?.kind}
      data-boundary-automatic={automatic ? 'true' : undefined}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ flex: 1, borderTop: '1px solid', borderColor: 'divider' }} />
        <Typography level="body-xs" textColor="text.tertiary" noWrap>
          {automatic
            ? 'Compacted automatically at the context limit - the model reads the summary below'
            : compacted
              ? 'Compacted - the model reads the summary below, not what is above'
              : 'Cleared - the model reads nothing above this line'}
        </Typography>
        <Box sx={{ flex: 1, borderTop: '1px solid', borderColor: 'divider' }} />
      </Stack>

      {compacted && message.content && (
        <Sheet variant="soft" color="neutral" sx={{ px: 2, py: 1.25, borderRadius: 'md' }}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ fontWeight: 'lg', mb: 0.5 }}>
            Summary of the conversation so far
          </Typography>
          <Box data-testid="chat-boundary-summary">
            <ReplyMarkdown text={message.content} />
          </Box>
        </Sheet>
      )}
    </Stack>
  );
}

/**
 * What came before the boundary, behind a disclosure.
 *
 * Collapsed by DEFAULT and kept whole: the point of both commands is that the conversation stops
 * being in front of the model, not that it stops being the user's record of their own work.
 * Mounted only when opened, so a thousand-message history costs nothing to walk past.
 */
function EarlierMessages({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Box
      component="details"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
      data-testid="chat-earlier-messages"
    >
      <Stack
        component="summary"
        direction="row"
        spacing={0.75}
        alignItems="center"
        sx={{
          cursor: 'pointer',
          listStyle: 'none',
          py: 0.25,
          color: 'text.tertiary',
          '&::-webkit-details-marker': { display: 'none' },
          '&:hover': { color: 'text.secondary' },
        }}
        data-testid="chat-earlier-messages-summary"
      >
        <Typography level="body-xs" textColor="inherit" noWrap>
          {open ? 'Hide' : 'Show'} the {count} earlier {count === 1 ? 'message' : 'messages'}
        </Typography>
        <Box sx={{ display: 'flex', opacity: 0.6 }}>
          <ChevronIcon open={open} />
        </Box>
      </Stack>
      {open && (
        <Stack spacing={3} sx={{ pt: 2 }}>
          {children}
        </Stack>
      )}
    </Box>
  );
}

const PIN_THRESHOLD_PX = 48;

export function MessageThread({
  messages,
  sessionId,
  noSession,
  streaming,
  onRespond,
  onMove,
  onContinue,
  status,
  footer,
}: {
  messages: ChatMessage[];
  /** Needed to read attachment bytes back; they are stored per conversation. */
  sessionId: string | null;
  /**
   * What the pane shows when there is no session at all, as opposed to a session with nothing
   * said in it yet. The two used to share one line, so a window with nothing open invited the
   * user to "send a message" while the composer refused to take one.
   */
  noSession?: ReactNode;
  /**
   * A reply is in flight for this conversation, however this window came to know it - so there
   * is nothing to resume, and the live line belongs at the foot of the last turn.
   */
  streaming: boolean;
  onRespond: RespondToApproval;
  /** Moves a command still running in the foreground into the background task panel. */
  onMove?: MoveCallToBackground;
  onContinue: () => void;
  /**
   * The live turn line, drawn at the foot of the reply in flight. Null when no turn is running,
   * which is the same condition `streaming` reports - so the two can never say different things.
   */
  status?: ReactNode;
  /**
   * Drawn after the last turn, in the reading column and inside the scroll - the background
   * task count. It belongs to the thread rather than to the composer: it is a running note on
   * what this conversation set going, so it reads as the last thing that happened in it.
   */
  footer?: ReactNode;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = messages[messages.length - 1];
  const lastContent = (last?.content.length ?? 0) + (last?.toolCalls?.length ?? 0);
  const empty = messages.length === 0;
  // Only the LAST boundary divides the thread. Earlier ones fall inside the folded section and
  // draw their own divider there, which is what a conversation compacted twice should look like.
  const boundary = lastBoundaryIndex(messages);

  // One function for both sides of the divider, taking each message's index in the WHOLE thread,
  // so a turn drawn inside the disclosure is the same turn with the same Continue and status
  // rules rather than a second rendering path that can drift from this one.
  const turn = (message: ChatMessage, index: number): ReactNode => {
    if (message.boundary) return <BoundaryRow key={message.id} message={message} />;
    if (message.relay) return <RelayTurn key={message.id} message={message} />;
    if (message.system) return <SystemTurn key={message.id} message={message} />;
    if (message.role === 'user') return <UserTurn key={message.id} message={message} sessionId={sessionId} />;
    return (
      <AssistantTurn
        key={message.id}
        message={message}
        onRespond={onRespond}
        {...(onMove ? { onMove } : {})}
        // Only the last turn, and only while nothing is running: resuming writes back
        // into its own message, so a Continue on an older one would edit history.
        {...(index === messages.length - 1 && !streaming ? { onContinue } : {})}
        {...(index === messages.length - 1 && streaming ? { status, live: true } : {})}
      />
    );
  };

  // A reader who scrolled up to look at something stays there; one at the bottom follows.
  const onScroll = () => {
    const el = host.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  };

  // Keyed on the growing last message too, so the view follows tokens as they stream in.
  useEffect(() => {
    if (last?.role === 'user') pinned.current = true;
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, lastContent]);

  // Content that grows or a viewport that shrinks with no new text (a plan panel, a queued
  // banner, a taller composer) would otherwise leave the foot of the reply behind the composer.
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const follow = () => {
      if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' });
    };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    if (column.current) observer.observe(column.current);
    return () => observer.disconnect();
  }, [empty]);

  if (empty) {
    return (
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 3 }}>
        {sessionId ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="chat-thread-empty">
            Send a message to start this conversation.
          </Typography>
        ) : (
          noSession
        )}
      </Box>
    );
  }

  return (
    // Scrolling on the outer box, the column on the inner one: reversing the two would put the
    // scrollbar in the middle of the window rather than at the edge of the pane.
    <Box ref={host} onScroll={onScroll} sx={{ flex: 1, ...scrollingColumnHostSx }} data-testid="chat-thread">
      <Stack ref={column} spacing={3} sx={{ ...contentColumnSx, py: 3 }}>
        {boundary > 0 && (
          <EarlierMessages count={boundary}>
            {messages.slice(0, boundary).map((message, index) => turn(message, index))}
          </EarlierMessages>
        )}
        {messages.slice(Math.max(boundary, 0)).map((message, index) => turn(message, Math.max(boundary, 0) + index))}
        {/* The turn line normally rides the reply, but the last message is not always that reply:
            a queued prompt or a relayed message can land after it while the turn still runs. */}
        {streaming && status && last && !(last.role === 'assistant' && !last.relay && !last.system) && (
          <Box>{status}</Box>
        )}
        {footer}
        {/* Stays the LAST child: the auto-scroll targets it, so anything below it would be
            scrolled past rather than brought into view. */}
        <div ref={bottom} />
      </Stack>
    </Box>
  );
}
