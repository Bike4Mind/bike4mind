import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import { CheckIcon, CopyIcon, WarningIcon } from './icons';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the outcome stays on the button before it offers to copy again, in ms. */
const FEEDBACK_MS = 2000;

const LABEL: Record<CopyState, string> = {
  idle: 'Copy message',
  copied: 'Copied',
  failed: 'Could not copy to the clipboard',
};

/**
 * Marks the button for the hover rule on the turn around it, as REPLY_COST_CLASS does: CSS
 * reveals it, so no turn holds hover state. Kept visible while it is reporting an outcome.
 */
export const COPY_BUTTON_CLASS = 'b4m-message-copy';

/** Spread into the turn's sx: hidden until the turn is hovered or something in it has focus. */
export const revealCopyButtonSx = {
  [`& .${COPY_BUTTON_CLASS}`]: { opacity: 0, transition: 'opacity 120ms' },
  [`&:hover .${COPY_BUTTON_CLASS}, &:focus-within .${COPY_BUTTON_CLASS}, & .${COPY_BUTTON_CLASS}:not([data-state="idle"])`]:
    { opacity: 1 },
} as const;

/**
 * Puts a message's text on the clipboard, and says whether that worked.
 *
 * Native `title` rather than a Joy tooltip for the same reason ReplyCost gives: one per turn
 * across a long transcript. A changed name on a focused button is not reliably re-read, so the
 * outcome also goes to a visually hidden live region, which must already be mounted to be heard.
 */
export function CopyMessageButton({ text, testId }: { text: string; testId: string }) {
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
      console.error('Copying a message to the clipboard failed', error);
      setState('failed');
    }
  };

  return (
    // The live region's containing block; without it the region resolves outside the transcript's
    // scroller, escapes its clip, and lengthens the document past the window.
    <Box component="span" sx={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton
        size="sm"
        variant="plain"
        color={state === 'failed' ? 'danger' : 'neutral'}
        aria-label={LABEL[state]}
        title={LABEL[state]}
        onClick={() => void copy()}
        className={COPY_BUTTON_CLASS}
        data-state={state}
        data-testid={testId}
        sx={{ '--IconButton-size': '1.5rem' }}
      >
        {state === 'copied' ? <CheckIcon /> : state === 'failed' ? <WarningIcon /> : <CopyIcon />}
      </IconButton>
      <Box
        component="span"
        role="status"
        data-testid={`${testId}-status`}
        sx={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {state === 'idle' ? '' : LABEL[state]}
      </Box>
    </Box>
  );
}
