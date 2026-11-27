import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import { VISUALLY_HIDDEN } from '../visuallyHidden';
import { CheckIcon, CopyIcon, WarningIcon } from './icons';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the outcome stays on the button before it offers to copy again, in ms. */
const FEEDBACK_MS = 2000;

const OUTCOME_LABEL: Record<Exclude<CopyState, 'idle'>, string> = {
  copied: 'Copied',
  failed: 'Could not copy to the clipboard',
};

/**
 * Marks the button for the hover rule on the turn around it, as REPLY_COST_CLASS does: CSS
 * reveals it, so no turn holds hover state. Kept visible while it is reporting an outcome.
 */
export const COPY_BUTTON_CLASS = 'b4m-message-copy';

/**
 * The same, for a button that copies one part of a turn (a code block, a tool's output). Its own
 * class so that hovering the turn reveals only the message's button, not every block's in it.
 */
export const BLOCK_COPY_BUTTON_CLASS = 'b4m-block-copy';

/** Hidden until the element this is spread on is hovered or something in it has focus. */
function revealOnHoverSx<C extends string>(className: C) {
  return {
    [`& .${className}`]: { opacity: 0, transition: 'opacity 120ms' },
    [`&:hover .${className}, &:focus-within .${className}, & .${className}:not([data-state="idle"])`]: {
      opacity: 1,
    },
  } as const;
}

/** Spread into the turn's sx. */
export const revealCopyButtonSx = revealOnHoverSx(COPY_BUTTON_CLASS);

/** Spread into the sx of the block a BLOCK_COPY_BUTTON_CLASS button copies. */
export const revealBlockCopyButtonSx = revealOnHoverSx(BLOCK_COPY_BUTTON_CLASS);

/**
 * Puts a message's text on the clipboard, and says whether that worked.
 *
 * Native `title` rather than a Joy tooltip for the same reason ReplyCost gives: one per turn
 * across a long transcript. A changed name on a focused button is not reliably re-read, so the
 * outcome also goes to a visually hidden live region, which must already be mounted to be heard.
 */
export function CopyMessageButton({
  text,
  testId,
  label = 'Copy message',
  className = COPY_BUTTON_CLASS,
}: {
  text: string;
  testId: string;
  /** What the idle button says it copies. */
  label?: string;
  className?: typeof COPY_BUTTON_CLASS | typeof BLOCK_COPY_BUTTON_CLASS;
}) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch (error) {
      // Denied permission or an unfocused document; the button says so, and the log says why.
      console.error(`${label} to the clipboard failed`, error);
      setState('failed');
    }
  };

  const name = state === 'idle' ? label : OUTCOME_LABEL[state];

  return (
    // The live region's containing block; without it the region resolves outside the transcript's
    // scroller, escapes its clip, and lengthens the document past the window.
    <Box component="span" sx={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton
        size="sm"
        variant="plain"
        color={state === 'failed' ? 'danger' : 'neutral'}
        aria-label={name}
        title={name}
        onClick={() => void copy()}
        className={className}
        data-state={state}
        data-testid={testId}
        sx={{ '--IconButton-size': '1.5rem' }}
      >
        {state === 'copied' ? <CheckIcon /> : state === 'failed' ? <WarningIcon /> : <CopyIcon />}
      </IconButton>
      <Box component="span" role="status" data-testid={`${testId}-status`} sx={VISUALLY_HIDDEN}>
        {state === 'idle' ? '' : name}
      </Box>
    </Box>
  );
}
