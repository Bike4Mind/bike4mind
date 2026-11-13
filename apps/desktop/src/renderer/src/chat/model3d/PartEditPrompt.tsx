import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import { useState, type KeyboardEvent } from 'react';
import type { ViewportPoint } from './ModelViewport';

/** The prompt's width, in CSS px; it is kept this far inside the viewport's edges. */
const PROMPT_WIDTH = 280;
const EDGE = 8;
/** Space between the picked point and the prompt, in CSS px. */
const GAP = 14;

type Props = {
  parts: readonly string[];
  /** Where the part was picked, in viewport px; the prompt opens just below it (above, near the bottom). */
  point: ViewportPoint;
  /** The viewport's size, to keep the prompt inside it. */
  bounds: { width: number; height: number };
  /** True while the turn is being put together (the close-up renders). */
  sending: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
};

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function partListLabel(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Point-and-edit's one affordance: a small field that floats by the picked part. Enter sends the
 * change as a turn about those parts, Escape closes it. Shift-click in the view adds parts.
 */
export function PartEditPrompt({ parts, point, bounds, sending, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const label = partListLabel(parts);
  const width = Math.min(PROMPT_WIDTH, bounds.width - EDGE * 2);
  const left = Math.min(Math.max(EDGE, point.x - width / 2), bounds.width - width - EDGE);
  const above = point.y > bounds.height - 96;
  const send = () => {
    const trimmed = text.trim();
    if (trimmed && !sending) onSend(trimmed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Kept from the view's own shortcuts, which act on the stage around this field.
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      role="group"
      aria-label={`Edit ${label}`}
      data-testid="model-pane-edit-prompt"
      onPointerDown={event => event.stopPropagation()}
      sx={{
        position: 'absolute',
        left,
        width,
        top: above ? point.y - GAP : point.y + GAP,
        transform: above ? 'translateY(-100%)' : undefined,
        p: 0.5,
        pl: 0.75,
        borderRadius: 'lg',
        bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 92%, transparent)',
        backdropFilter: 'blur(10px) saturate(1.4)',
        border: '1px solid',
        borderColor: 'divider',
        boxShadow: 'md',
        zIndex: 2,
      }}
    >
      <Chip
        size="sm"
        variant="soft"
        color="primary"
        sx={{ flexShrink: 1, minWidth: 0, maxWidth: '45%' }}
        title={label}
        data-testid="model-pane-edit-parts"
      >
        {parts.length > 2 ? `${parts.length} parts` : label}
      </Chip>
      <Input
        size="sm"
        variant="plain"
        autoFocus
        value={text}
        disabled={sending}
        placeholder="What should change?"
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
        slotProps={{ input: { 'aria-label': `Describe a change to ${label}`, 'data-testid': 'model-pane-edit-input' } }}
        sx={{ flex: 1, minWidth: 0, bgcolor: 'transparent', '--Input-focusedThickness': '0px', px: 0.5 }}
      />
      <IconButton
        size="sm"
        variant="solid"
        color="primary"
        aria-label={`Send the change to ${label}`}
        disabled={!text.trim() || sending}
        loading={sending}
        onClick={send}
        data-testid="model-pane-edit-send-btn"
        sx={{ borderRadius: 'md', '--IconButton-size': '26px' }}
      >
        <SendIcon />
      </IconButton>
    </Stack>
  );
}
