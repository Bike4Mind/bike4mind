import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import ButtonGroup from '@mui/joy/ButtonGroup';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import IconButton from '@mui/joy/IconButton';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import { isStoppableState } from '@shared/agentState';
import type { ChatApprovalAnswer, ChatMessage, ChatQueuedMessage, ChatToolCall, SendMessageResult } from '@shared/chat';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { hostChat } from '../../host/hostChat';
import { hostClient } from '../../host/HostClient';
import { sessionEvents } from '../../host/sessionEvents';
import { hostForSession } from '../../host/sessionHost';
import { CaretDownIcon } from '../icons';
import { ToolCallList } from '../ToolCallList';
import { MessageThread } from '../MessageThread';
import { HeldRelayRow } from '../HeldRelayCard';
import { useHeldRelays } from '../useHeldRelays';
import { TaskDecisionPanel } from './TaskDecisionPanel';
import { markSessionViewed } from '../markSessionViewed';
import { activityLabel } from './activity';
import { AgentPrIndicator } from './AgentPrIndicator';
import { AgentStateChip } from './AgentStateChip';
import type { AgentActions } from './OrchestratorStage';
import type { AgentView } from './roster';
import type { AgentPersona } from '@shared/agentPersona';

const QUEUED_NOTE = 'Queued - it will send when this agent finishes its current step.';

export interface AgentDetailsSkin {
  light: { background: string; border: string };
  dark: { background: string; border: string };
  /** The window's corner radius, for a scene whose own chrome is square. */
  radius?: string;
}

interface AgentPeekDrawerProps {
  agent: AgentView;
  persona: AgentPersona | undefined;
  onClose(): void;
  actions: AgentActions;
  skin?: AgentDetailsSkin;
  visible?: boolean;
  /** Opens the in-app PR details, as the views' badges do. */
  onOpenPr?(id: string): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * The session's messages, refetched whenever `refreshKey` changes. getSession includes the reply in
 * flight, so a call parked at the approval gate is in here with its `approvalId`.
 * `viewed` marks the session read; `enabled` false skips the fetch.
 */
export function useSessionMessages(
  agentId: string,
  refreshKey: string,
  viewed = false,
  enabled = true
): { messages: ChatMessage[]; loadError: string | null } {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    let loading = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (loading) {
        dirty = true;
        return;
      }
      loading = true;
      dirty = false;
      try {
        const session = await hostChat.getSession(agentId, false);
        if (!stale) {
          setLoadError(null);
          setMessages(session ? session.messages : []);
        }
      } catch (error: unknown) {
        if (!stale) setLoadError(errorText(error));
      } finally {
        loading = false;
        if (dirty && !stale) schedule();
      }
    };
    const schedule = () => {
      if (timer !== undefined || stale) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, 200);
    };
    const hostId = hostForSession(agentId);
    const unsubscribe = sessionEvents.subscribe({ hostId, sessionId: agentId }, { event: schedule, resync: schedule });
    const unsubscribeQueue = hostClient.onNotification('session/queueChanged', ({ event }, from) => {
      if (from === hostId && event.sessionId === agentId) schedule();
    });
    void load();
    return () => {
      stale = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeQueue();
    };
  }, [agentId, refreshKey, enabled]);
  useEffect(() => {
    if (!viewed) return;
    const acknowledge = () => markSessionViewed(agentId);
    acknowledge();
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => {
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
    };
  }, [agentId, viewed, messages, refreshKey]);
  return { messages, loadError };
}

/**
 * What changes when this agent may have a new message or request. The status push flips the state
 * when the first request parks and when the last settles; while it stays 'needs-you', a further
 * request shows up only as a new activity, which the roster already folds from the stream.
 */
export function refreshKeyOf(agent: AgentView): string {
  const waitingOn = agent.state === 'needs-you' && agent.activity ? activityLabel(agent.activity) : '';
  return [agent.updatedAt, agent.state, waitingOn].join('\n');
}

/**
 * The agent's requests parked at the approval gate, drawn with the thread's own cards and answered
 * through the same `respondToApproval` call. An answered card goes at once rather than waiting for
 * the status push, so a second click can never answer it twice.
 */
export function PendingRequests({
  sessionId,
  calls,
  onAnswered,
}: {
  /** The session the calls belong to. */
  sessionId: string;
  calls: ChatToolCall[];
  onAnswered?(answer: ChatApprovalAnswer): void;
}) {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const open = calls.filter(call => call.approvalId && !answered.has(call.approvalId));

  const respond = (approvalId: string, answer: ChatApprovalAnswer) => {
    setError(null);
    setAnswered(current => new Set(current).add(approvalId));
    hostChat.respondToApproval(sessionId, approvalId, answer).then(
      () => onAnswered?.(answer),
      (caught: unknown) => {
        setAnswered(current => {
          const next = new Set(current);
          next.delete(approvalId);
          return next;
        });
        setError(errorText(caught));
      }
    );
  };

  if (open.length === 0 && !error) return null;
  return (
    <Box data-testid="orchestrator-peek-pending">
      {error && (
        <Typography level="body-xs" color="danger" data-testid="orchestrator-peek-pending-error">
          {error}
        </Typography>
      )}
      <ToolCallList calls={open} onRespond={respond} />
    </Box>
  );
}

function ReplyBox({ agentId, actionButton, onSent }: { agentId: string; actionButton: ReactNode; onSent(): void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<ChatQueuedMessage | null>(null);
  const [sending, setSending] = useState(false);
  // A ref as well as state: two keystrokes can land before React re-renders with `sending` set.
  const sendingRef = useRef(false);

  // This session's queued ids as of the latest change; `version` counts changes so a send can tell
  // whether any arrived while it was in flight.
  const latestQueue = useRef<{ version: number; ids: ReadonlySet<string> }>({ version: 0, ids: new Set() });

  // Main flushes, merges or returns queued messages on its own; the note goes once ours leaves the queue.
  // Subscribed for the box's whole life, not just while a note shows: main can announce the enqueue
  // and the flush before `sendMessage` resolves, and a listener added after that would never hear it.
  useEffect(() => {
    const hostId = hostForSession(agentId);
    return hostClient.onNotification('session/queueChanged', ({ event }, from) => {
      if (from !== hostId || event.sessionId !== agentId) return;
      const ids = new Set(event.queued.map(message => message.id));
      latestQueue.current = { version: latestQueue.current.version + 1, ids };
      setQueued(current => (current && !ids.has(current.id) ? null : current));
    });
  }, [agentId]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const versionBefore = latestQueue.current.version;
    try {
      const result = await hostChat.sendMessage({ sessionId: agentId, text: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setText('');
      onSent();
      const seen = latestQueue.current;
      const stillQueued = result.queued && (seen.version === versionBefore || seen.ids.has(result.message.id));
      setQueued(stillQueued ? result.message : null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const settleQueued = async (action: 'cancelQueuedMessage' | 'sendQueuedMessageNow') => {
    if (!queued) return;
    try {
      await hostChat[action](agentId, queued.id);
      setQueued(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Textarea
        minRows={1}
        maxRows={6}
        placeholder="Reply to this agent"
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
        slotProps={{ textarea: { 'data-testid': 'orchestrator-peek-reply-input' } }}
      />
      {error && (
        <Typography level="body-xs" color="danger" data-testid="orchestrator-peek-error">
          {error}
        </Typography>
      )}
      {queued && (
        <Box data-testid="orchestrator-peek-queued-note" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Typography level="body-xs">{QUEUED_NOTE}</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              data-testid="orchestrator-peek-queued-cancel-btn"
              onClick={() => void settleQueued('cancelQueuedMessage')}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              data-testid="orchestrator-peek-queued-send-now-btn"
              onClick={() => void settleQueued('sendQueuedMessageNow')}
            >
              Send now
            </Button>
          </Box>
        </Box>
      )}
      <Box
        data-testid="orchestrator-peek-action-row"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
      >
        {actionButton}
        <Button
          size="sm"
          disabled={!text.trim() || sending}
          data-testid="orchestrator-peek-send-btn"
          onClick={() => void send()}
        >
          Send
        </Button>
      </Box>
    </Box>
  );
}

export function AgentPeekDrawer({ agent, onClose, actions, skin, visible = true, onOpenPr }: AgentPeekDrawerProps) {
  const mode = useTheme().palette.mode;
  const palette = skin?.[mode];
  const [actionsOpen, setActionsOpen] = useState(false);
  const [taskControlsState, setTaskControlsState] = useState<'unopened' | 'open' | 'closed'>('unopened');
  const taskControlsId = useId();
  useEffect(() => {
    setTaskControlsState('unopened');
  }, [agent.id]);
  useEffect(() => {
    if (!visible) setActionsOpen(false);
  }, [visible]);
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const { messages, loadError } = useSessionMessages(agent.id, `${refreshKeyOf(agent)}\n${revision}`, visible);
  const refresh = () => setRevision(value => value + 1);
  const canStop = isStoppableState(agent.state);
  const heldRelays = useHeldRelays(visible ? agent.id : null);

  // Continue and Retry are also on the Needs-you strip; main refuses the second click as `busy`.
  const rerun = (start: (sessionId: string) => Promise<SendMessageResult>) => {
    setActionError(null);
    void start(agent.id).then(
      result => {
        if (!result.ok && !result.busy) setActionError(result.error);
        refresh();
      },
      error => setActionError(errorText(error))
    );
  };

  const drawerRef = useRef<HTMLDivElement>(null);
  // Focus moves in on open and back to the opener on close; a drawer swapped to another agent keeps its place.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus();
    return () => {
      if (
        opener?.isConnected &&
        (document.activeElement === document.body || drawerRef.current?.contains(document.activeElement))
      )
        opener.focus();
    };
  }, []);

  return (
    <Box
      ref={drawerRef}
      role="region"
      aria-label={`Agent details: ${agent.title}`}
      tabIndex={-1}
      data-testid="orchestrator-peek-drawer"
      data-agent-details-panel
      sx={{
        outline: 'none',
        width: 320,
        maxWidth: '100%',
        height: 'min(680px, 100cqh - 24px)',
        maxHeight: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        flexShrink: 0,
        overflowY: 'hidden',
        overflowX: 'hidden',
        // Unbroken worktree paths in agent messages would otherwise widen the drawer.
        overflowWrap: 'anywhere',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.25,
        border: '1px solid',
        borderRadius: skin?.radius ?? 'md',
        borderColor: palette?.border ?? 'divider',
        bgcolor: palette?.background ?? 'background.surface',
        boxShadow: 'md',
        '& > *': { flexShrink: 0 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            level="title-sm"
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={agent.title}
          >
            {agent.title}
          </Typography>
        </Box>
        <AgentPrIndicator
          agentId={agent.id}
          pr={agent.pr}
          onOpen={onOpenPr && (() => onOpenPr(agent.id))}
          testId="orchestrator-peek-pr"
        />
        <AgentStateChip
          state={agent.state}
          preparing={agent.preparing !== undefined}
          deciding={agent.decision !== undefined}
          backgroundJobs={agent.background?.running}
        />
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Close agent details"
          data-testid="orchestrator-peek-close-btn"
          onClick={onClose}
        >
          {'\u00D7'}
        </IconButton>
      </Box>

      {(loadError || actionError) && (
        <Typography level="body-xs" color="danger" data-testid="orchestrator-peek-load-error">
          {loadError || actionError}
        </Typography>
      )}
      {agent.workerTask && (
        <Box sx={{ flex: '0 1 auto !important', minHeight: 0, maxHeight: '40%', overflowY: 'auto' }}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            aria-expanded={taskControlsState === 'open'}
            aria-controls={taskControlsId}
            data-testid="orchestrator-peek-task-toggle"
            onClick={() => setTaskControlsState(current => (current === 'open' ? 'closed' : 'open'))}
          >
            Review task
          </Button>
          <Box
            id={taskControlsId}
            hidden={taskControlsState !== 'open'}
            sx={{ display: taskControlsState === 'open' ? 'block' : 'none' }}
            data-testid="orchestrator-peek-task-controls"
          >
            {taskControlsState !== 'unopened' && <TaskDecisionPanel key={agent.id} agent={agent} compact />}
          </Box>
        </Box>
      )}
      {heldRelays.held.length > 0 && (
        <Box
          data-testid="orchestrator-peek-held-relays"
          sx={{ flex: '0 1 auto !important', minHeight: 0, maxHeight: '35%', overflowY: 'auto' }}
        >
          {heldRelays.held.map(entry => (
            <HeldRelayRow key={entry.id} held={entry} onResolve={heldRelays.resolve} onOpenSession={actions.open} />
          ))}
        </Box>
      )}
      <Box
        data-testid="orchestrator-peek-conversation"
        sx={{
          display: 'flex',
          flex: '1 1 0 !important',
          minHeight: 0,
          overflow: 'hidden',
          '& > *': { minWidth: 0 },
          '& [data-testid="chat-thread"] > *': { px: 0.5, py: 1 },
        }}
      >
        <MessageThread
          messages={messages}
          sessionId={agent.id}
          streaming={agent.state === 'working'}
          status={
            agent.activity ? (
              <Typography level="body-xs" color="primary">
                {activityLabel(agent.activity)}
              </Typography>
            ) : undefined
          }
          onRespond={(approvalId, answer) => {
            setActionError(null);
            void hostChat
              .respondToApproval(agent.id, approvalId, answer)
              .then(refresh, error => setActionError(errorText(error)));
          }}
          onContinue={() => rerun(window.b4m.chat.continueReply)}
          // Only on a failed turn: regenerating a finished worker would set its task running again.
          {...(agent.state === 'failed' && { onRegenerate: () => rerun(window.b4m.chat.regenerateReply) })}
        />
      </Box>

      <ReplyBox
        agentId={agent.id}
        onSent={refresh}
        actionButton={
          <Dropdown open={visible && actionsOpen} onOpenChange={(_event, open) => setActionsOpen(visible && open)}>
            <ButtonGroup size="sm" variant="outlined" color="neutral" data-testid="orchestrator-peek-actions">
              <Button data-testid="orchestrator-peek-open-btn" onClick={() => actions.open(agent.id)}>
                Open
              </Button>
              <MenuButton
                aria-label="More agent actions"
                data-testid="orchestrator-peek-actions-menu-btn"
                sx={{ px: 0.75 }}
              >
                <CaretDownIcon />
              </MenuButton>
            </ButtonGroup>
            <Menu size="sm" placement="top-start" data-testid="orchestrator-peek-actions-menu">
              {canStop && (
                <MenuItem
                  color="danger"
                  data-testid="orchestrator-peek-stop-btn"
                  onClick={() => void actions.stop(agent.id)}
                >
                  Stop
                </MenuItem>
              )}
              <MenuItem
                data-testid="orchestrator-peek-archive-btn"
                onClick={() => {
                  actions.archive(agent.id);
                  onClose();
                }}
              >
                Archive
              </MenuItem>
            </Menu>
          </Dropdown>
        }
      />
    </Box>
  );
}
