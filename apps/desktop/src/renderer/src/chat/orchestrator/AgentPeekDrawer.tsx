import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { snippetOf } from '@shared/agentOutcome';
import type { ChatMessage, ChatQueuedMessage } from '@shared/chat';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { activityLabel } from './activity';
import { AgentStateChip } from './AgentStateChip';
import type { AgentActions } from './OrchestratorStage';
import type { AgentView } from './roster';

const RECENT_MESSAGES = 3;
const MESSAGE_SNIPPET_MAX = 280;
const QUEUED_NOTE = 'Queued - it will send when this agent finishes its current step.';

interface AgentPeekDrawerProps {
  agent: AgentView;
  onClose(): void;
  actions: AgentActions;
}

/** The newest messages, refetched whenever the agent's summary changes (a finished step bumps `updatedAt`). */
function useRecentMessages(agentId: string, updatedAt: string): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  useEffect(() => {
    let stale = false;
    void window.b4m.chat.getSession(agentId).then(session => {
      if (!stale) setMessages(session ? session.messages.slice(-RECENT_MESSAGES) : []);
    });
    return () => {
      stale = true;
    };
  }, [agentId, updatedAt]);
  return messages;
}

function ReplyBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<ChatQueuedMessage | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    const result = await window.b4m.chat.sendMessage({ sessionId: agentId, text: trimmed });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText('');
    setQueued(result.queued ? result.message : null);
  };

  const settleQueued = async (action: 'cancelQueuedMessage' | 'sendQueuedMessageNow') => {
    if (!queued) return;
    await window.b4m.chat[action](agentId, queued.id);
    setQueued(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Textarea
        minRows={2}
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
      <Button size="sm" disabled={!text.trim()} data-testid="orchestrator-peek-send-btn" onClick={() => void send()}>
        Send
      </Button>
    </Box>
  );
}

export function AgentPeekDrawer({ agent, onClose, actions }: AgentPeekDrawerProps) {
  const messages = useRecentMessages(agent.id, agent.updatedAt);
  const canStop = agent.state === 'working' || agent.state === 'needs-you';

  return (
    <Box
      data-testid="orchestrator-peek-drawer"
      sx={{
        width: 340,
        flexShrink: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.surface',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          level="title-md"
          sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={agent.title}
        >
          {agent.title}
        </Typography>
        <AgentStateChip state={agent.state} />
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Close"
          data-testid="orchestrator-peek-close-btn"
          onClick={onClose}
        >
          {'\u00D7'}
        </IconButton>
      </Box>

      <Typography
        level="body-xs"
        sx={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {agent.seedPrompt}
      </Typography>

      {agent.activity && (
        <Typography level="body-sm" color="primary" data-testid="orchestrator-peek-activity">
          {activityLabel(agent.activity)}
        </Typography>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {messages.map(message => (
          <Typography key={message.id} level="body-xs" data-testid="orchestrator-peek-message">
            <b>{message.role}</b>: {snippetOf(message.content, MESSAGE_SNIPPET_MAX)}
          </Typography>
        ))}
      </Box>

      <ReplyBox agentId={agent.id} />

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="outlined"
          data-testid="orchestrator-peek-open-btn"
          onClick={() => actions.open(agent.id)}
        >
          Open
        </Button>
        {canStop && (
          <Button
            size="sm"
            variant="outlined"
            color="danger"
            data-testid="orchestrator-peek-stop-btn"
            onClick={() => actions.stop(agent.id)}
          >
            Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="orchestrator-peek-archive-btn"
          onClick={() => {
            actions.archive(agent.id);
            onClose();
          }}
        >
          Archive
        </Button>
      </Box>
    </Box>
  );
}
