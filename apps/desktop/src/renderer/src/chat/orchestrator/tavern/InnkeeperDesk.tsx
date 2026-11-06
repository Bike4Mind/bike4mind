import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export const INNKEEPER_GREETING = "What'll it be?";

/** The quick orders on the slip: `send` goes at once, otherwise the text starts a draft to finish. */
const QUICK_ORDERS: readonly { label: string; text: string; send: boolean }[] = [
  {
    label: 'Status report',
    text: 'Give me a short status report: what each agent is doing, what is done, and what is left.',
    send: true,
  },
  { label: 'Ask a question', text: 'Quick question: ', send: false },
  { label: 'Post a quest', text: 'New quest: ', send: false },
];

const SLIP_WIDTH = 'clamp(290px, 31%, 380px)';
const PARCHMENT = 'rgba(255, 250, 240, 0.96)';
const INK = '#2a1d10';

/**
 * The order slip at the bar: a short message to the orchestrating conversation, the same thread the
 * composer writes to. Long drafts and attachments stay with the composer. Escape and a send close it.
 */
export function OrderSlip({
  seed,
  onSend,
  onClose,
  onOpenConversation,
}: {
  seed: string;
  onSend(text: string): void;
  onClose(): void;
  onOpenConversation(): void;
}) {
  const [text, setText] = useState(seed);
  const input = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // Back to whoever opened it (the Innkeeper, usually) once it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const send = (order: string) => {
    const trimmed = order.trim();
    if (!trimmed) return;
    onSend(trimmed);
    onClose();
  };

  const startDraft = (draft: string) => {
    setText(draft);
    window.requestAnimationFrame(() => {
      const field = input.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(draft.length, draft.length);
    });
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send(text);
  };

  const onSlipKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    // Claimed, so the docked conversation (ThreadDock) does not close on the same key.
    event.preventDefault();
    onClose();
  };

  return (
    <Box
      role="dialog"
      aria-label="Order for the Innkeeper"
      data-testid="orchestrator-tavern-order-slip"
      // Holds the Tavern's chrome up while open (ambient.ts).
      data-ambient-hold
      onKeyDown={onSlipKeyDown}
      sx={{
        position: 'absolute',
        top: '3%',
        // Just right of the Innkeeper behind the bar (INNKEEPER_POINT), so he stays in view; on a
        // scene too narrow for that, as far right as it fits.
        left: `min(67%, calc(98% - ${SLIP_WIDTH}))`,
        zIndex: 300,
        width: SLIP_WIDTH,
        maxHeight: '94%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        p: 1.25,
        borderRadius: 'md',
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'divider',
        boxShadow: 'lg',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1 }}>
          {INNKEEPER_GREETING}
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close the order slip"
          title="Close (Esc)"
          onClick={onClose}
          data-testid="orchestrator-tavern-order-close-btn"
        >
          {'×'}
        </IconButton>
      </Box>
      <Textarea
        size="sm"
        minRows={2}
        maxRows={5}
        value={text}
        placeholder="Tell the Innkeeper what you need"
        onChange={event => setText(event.target.value)}
        onKeyDown={onFieldKeyDown}
        slotProps={{ textarea: { ref: input, 'data-testid': 'orchestrator-tavern-order-input' } }}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {QUICK_ORDERS.map(order => (
          <Button
            key={order.label}
            size="sm"
            variant="soft"
            color="neutral"
            onClick={() => (order.send ? send(order.text) : startDraft(order.text))}
            data-testid={`orchestrator-tavern-order-chip-${order.label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            {order.label}
          </Button>
        ))}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onOpenConversation}
          data-testid="orchestrator-tavern-order-open-conversation-btn"
          sx={{ mr: 'auto', px: 0.75, whiteSpace: 'nowrap' }}
        >
          Open conversation
        </Button>
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() => send(text)}
          data-testid="orchestrator-tavern-order-send-btn"
        >
          Send
        </Button>
      </Box>
    </Box>
  );
}

/**
 * The Innkeeper's latest reply as a speech bubble beside the bar, for while the conversation is out
 * of sight: its opening line or two, and the way to the whole reply.
 */
export function ReplyBubble({
  snippet,
  onReadAll,
  onDismiss,
}: {
  snippet: string;
  onReadAll(): void;
  onDismiss(): void;
}) {
  const action = {
    p: 0,
    border: 0,
    bgcolor: 'transparent',
    color: INK,
    font: 'inherit',
    cursor: 'pointer',
    '&:focus-visible': { outline: `2px solid ${INK}`, outlineOffset: 2, borderRadius: '2px' },
  } as const;
  return (
    <Box
      data-testid="orchestrator-tavern-reply-bubble"
      role="status"
      sx={{
        position: 'absolute',
        top: '3%',
        // Ends just left of the Innkeeper behind the bar (INNKEEPER_POINT), its tail pointing at him.
        right: '42%',
        zIndex: 250,
        width: 'clamp(180px, 34%, 320px)',
        px: '0.75em',
        py: '0.5em',
        borderRadius: '8px',
        border: `2px solid ${INK}`,
        bgcolor: PARCHMENT,
        color: INK,
        fontSize: 'clamp(11px, 2.4cqh, 14px)',
        lineHeight: 1.35,
        '&::after': {
          content: '""',
          position: 'absolute',
          right: -9,
          top: '60%',
          borderWidth: '7px 0 7px 9px',
          borderStyle: 'solid',
          borderColor: `transparent transparent transparent ${INK}`,
        },
      }}
    >
      <Box
        data-testid="orchestrator-tavern-reply-text"
        sx={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {snippet}
      </Box>
      <Box sx={{ display: 'flex', gap: '1em', mt: '0.35em', fontWeight: 700 }}>
        <Box
          component="button"
          type="button"
          onClick={onReadAll}
          sx={action}
          data-testid="orchestrator-tavern-reply-read-btn"
        >
          Read all
        </Box>
        <Box
          component="button"
          type="button"
          onClick={onDismiss}
          sx={{ ...action, ml: 'auto', fontWeight: 500 }}
          data-testid="orchestrator-tavern-reply-dismiss-btn"
        >
          Dismiss
        </Box>
      </Box>
    </Box>
  );
}
