import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { useCallback, useState } from 'react';

export type CorrectionComposerProps = {
  onCancel: () => void;
  /** Receives the trimmed correction; the composer never submits an empty one. */
  onSubmit: (correction: string) => void;
  isSubmitting?: boolean;
};

/**
 * Inline "what was wrong with this answer?" field, rendered directly beneath the answer it
 * corrects. Anchored to the message rather than hoisted into a modal so the user can still read
 * the answer they are describing while they describe it.
 */
export function CorrectionComposer({ onCancel, onSubmit, isSubmitting = false }: CorrectionComposerProps) {
  const [correction, setCorrection] = useState('');
  const trimmed = correction.trim();

  const handleSubmit = useCallback(() => {
    if (!trimmed || isSubmitting) return;
    onSubmit(trimmed);
  }, [trimmed, isSubmitting, onSubmit]);

  return (
    <Box
      data-testid="message-correction-composer"
      sx={{
        mt: 1,
        p: 1.5,
        borderRadius: '8px',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        backgroundColor: 'background.level1',
      }}
    >
      <Typography level="body-xs" sx={{ mb: 0.75 }}>
        What was wrong with this answer?
      </Typography>
      <Textarea
        // Joy spreads unknown props onto the root wrapper, so the test id has to be slotted onto
        // the real <textarea> or nothing can type into it.
        slotProps={{ textarea: { 'data-testid': 'message-correction-input' } }}
        autoFocus
        minRows={2}
        maxRows={8}
        value={correction}
        disabled={isSubmitting}
        placeholder="e.g. the revenue figure is for Q3, not Q2"
        onChange={event => setCorrection(event.target.value)}
        // Enter sends, Shift+Enter breaks the line - the same contract as the main composer, so
        // the habit carries over. Escape abandons without sending.
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSubmit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
        <Button
          data-testid="message-correction-cancel-btn"
          size="sm"
          variant="plain"
          color="neutral"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          data-testid="message-correction-submit-btn"
          size="sm"
          variant="solid"
          color="primary"
          loading={isSubmitting}
          disabled={!trimmed}
          onClick={handleSubmit}
        >
          Send correction
        </Button>
      </Stack>
    </Box>
  );
}
