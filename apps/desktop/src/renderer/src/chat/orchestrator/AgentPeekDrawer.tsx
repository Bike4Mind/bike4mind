import { TaskDecisionPanel } from './TaskDecisionPanel';
import { TaskDecisionCard } from '../TaskDecisionCards';
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
import { snippetOf } from '@shared/agentOutcome';
import { isStoppableState } from '@shared/agentState';
import type { ChatApprovalAnswer, ChatMessage, ChatQueuedMessage, ChatToolCall } from '@shared/chat';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CaretDownIcon } from '../icons';
import { ToolCallList } from '../ToolCallList';
import { groupToolCalls } from '../toolRows';
import { pendingCallsIn } from '@shared/needsYou';
import { activityLabel } from './activity';
import { AgentStateChip } from './AgentStateChip';
import type { AgentActions } from './OrchestratorStage';
import type { AgentView } from './roster';
import type { AgentPersona } from '@shared/agentPersona';

const RECENT_MESSAGES = 3;
const MESSAGE_SNIPPET_MAX = 280;
const QUEUED_NOTE = 'Queued - it will send when this agent finishes its current step.';

export interface AgentDetailsSkin {
  light: { background: string; border: string };
  dark: { background: string; border: string };
}

interface AgentPeekDrawerProps {
  agent: AgentView;
  persona: AgentPersona | undefined;
  onClose(): void;
  actions: AgentActions;
  skin?: AgentDetailsSkin;
  visible?: boolean;
}

function roleLabel(role: string): string {
  if (role === 'assistant') return 'Agent';
  if (role === 'user') return 'You';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * The session's messages, refetched whenever `refreshKey` changes. getSession includes the reply in
 * flight, so a call parked at the approval gate is in here with its `approvalId`.
 */
export function useSessionMessages(
  agentId: string,
  refreshKey: string
): { messages: ChatMessage[]; loadError: string | null } {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    window.b4m.chat.getSession(agentId).then(
      session => {
        if (stale) return;
        setLoadError(null);
        setMessages(session ? session.messages : []);
      },
      (error: unknown) => {
        if (!stale) setLoadError(errorText(error));
      }
    );
    return () => {
      stale = true;
    };
  }, [agentId, refreshKey]);
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

/** One line for the message, or null when it has nothing to show. */
function messageLine(message: ChatMessage): string | null {
  if (message.content.trim()) return snippetOf(message.content, MESSAGE_SNIPPET_MAX);
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) return null;
  return snippetOf(
    groupToolCalls(calls)
      .map(group => group.label)
      .join(', '),
    MESSAGE_SNIPPET_MAX
  );
}

/**
 * The agent's requests parked at the approval gate, drawn with the thread's own cards and answered
 * through the same `respondToApproval` call. An answered card goes at once rather than waiting for
 * the status push, so a second click can never answer it twice.
 */
export function PendingRequests({ calls }: { calls: ChatToolCall[] }) {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const open = calls.filter(call => call.approvalId && !answered.has(call.approvalId));

  const respond = (approvalId: string, answer: ChatApprovalAnswer) => {
    setError(null);
    setAnswered(current => new Set(current).add(approvalId));
    window.b4m.chat.respondToApproval(approvalId, answer).catch((caught: unknown) => {
      setAnswered(current => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
      setError(errorText(caught));
    });
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

function ReplyBox({ agentId, actionButton }: { agentId: string; actionButton: ReactNode }) {
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
    return window.b4m.chat.onQueueChanged(event => {
      if (event.sessionId !== agentId) return;
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
      const result = await window.b4m.chat.sendMessage({ sessionId: agentId, text: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setText('');
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
      await window.b4m.chat[action](agentId, queued.id);
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
              variant="plain"
              data-testid="orchestrator-peek-queued-cancel-btn"
              onClick={() => void settleQueued('cancelQueuedMessage')}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="plain"
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

export function AgentPeekDrawer({ agent, persona, onClose, actions, skin, visible = true }: AgentPeekDrawerProps) {
  const mode = useTheme().palette.mode;
  const palette = skin?.[mode];
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    if (!visible) setActionsOpen(false);
  }, [visible]);
  const { messages, loadError } = useSessionMessages(agent.id, refreshKeyOf(agent));
  // The snapshot can trail the status push, so the state decides whether anything is still waiting.
  const pending = agent.state === 'needs-you' ? pendingCallsIn(messages) : [];
  const recent = messages
    .flatMap(message => {
      const line = messageLine(message);
      return line === null ? [] : [{ id: message.id, role: message.role, line }];
    })
    .slice(-RECENT_MESSAGES);
  const canStop = isStoppableState(agent.state);

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
        maxHeight: '100%',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
        flexShrink: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        // Unbroken worktree paths in agent messages would otherwise widen the drawer.
        overflowWrap: 'anywhere',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.25,
        border: '1px solid',
        borderRadius: 'md',
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
          {persona && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="orchestrator-peek-persona">
              {`${persona.label} \u00B7 ${persona.shortTitle}`}
            </Typography>
          )}
        </Box>
        <AgentStateChip
          state={agent.state}
          preparing={agent.preparing !== undefined}
          deciding={agent.decision !== undefined}
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

      {agent.decision && <TaskDecisionCard sessionId={agent.id} title={agent.title} decision={agent.decision} />}
      {pending.length > 0 && <PendingRequests calls={pending} />}
      <TaskDecisionPanel agent={agent} compact />

      {agent.activity && (
        <Typography level="body-sm" color="primary" data-testid="orchestrator-peek-activity">
          {activityLabel(agent.activity)}
        </Typography>
      )}

      {loadError && (
        <Typography level="body-xs" color="danger" data-testid="orchestrator-peek-load-error">
          {loadError}
        </Typography>
      )}
      <Box component="details" data-testid="orchestrator-peek-context">
        <Box
          component="summary"
          data-testid="orchestrator-peek-context-toggle"
          sx={{ cursor: 'pointer', fontFamily: 'body', fontSize: 'xs', color: 'text.secondary', py: 0.5 }}
        >
          Task and recent messages
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, pt: 0.75 }}>
          <Typography level="body-xs">{agent.seedPrompt}</Typography>
          {recent.map(message => (
            <Typography key={message.id} level="body-xs" data-testid="orchestrator-peek-message">
              <b>{roleLabel(message.role)}</b>: {message.line}
            </Typography>
          ))}
        </Box>
      </Box>

      <ReplyBox
        agentId={agent.id}
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
