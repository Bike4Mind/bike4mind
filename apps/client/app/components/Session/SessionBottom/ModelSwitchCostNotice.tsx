import { useState } from 'react';
import { Typography } from '@mui/joy';
import { ComposerNote } from '../ComposerNote';

const creditFormat = new Intl.NumberFormat('en-US');

/**
 * Non-blocking note in the stack above the composer (SessionBottom) when the selected model is not the
 * one holding this conversation's prompt cache. `credits` comes from getModelSwitchCostNotice; null hides it.
 * Dismissal lasts for that one figure, so a different switch shows it again.
 */
export function ModelSwitchCostNotice({ credits }: { credits: number | null }) {
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  if (credits === null || dismissedFor === credits) return null;

  return (
    <ComposerNote
      data-testid="chat-model-switch-cost-notice"
      dismissTestId="chat-model-switch-cost-notice-dismiss"
      dismissLabel="Dismiss model switch cost note"
      onDismiss={() => setDismissedFor(credits)}
    >
      <Typography data-testid="chat-model-switch-cost-notice-text" sx={{ fontSize: '13px', color: 'text.primary' }}>
        Switching models re-reads this conversation: about {creditFormat.format(credits)} credits for the next message.
      </Typography>
    </ComposerNote>
  );
}
