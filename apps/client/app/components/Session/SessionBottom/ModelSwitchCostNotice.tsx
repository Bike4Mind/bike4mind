import { useState } from 'react';
import { Typography } from '@mui/joy';
import { ComposerNote } from '../ComposerNote';

const creditFormat = new Intl.NumberFormat('en-US');

interface CacheCostNoticeProps {
  credits: number | null;
  /** Prefix of the note's test ids: `<id>`, `<id>-text`, `<id>-dismiss`. */
  testId: string;
  dismissLabel: string;
  /** The sentence before ": about N credits for the next message." */
  lead: string;
}

/**
 * Non-blocking note in the stack above the composer (SessionBottom) for a next message that has to
 * re-write this conversation's prompt cache. `credits` comes from modelSwitchCost; null hides it.
 */
export function CacheCostNotice({ credits, testId, dismissLabel, lead }: CacheCostNoticeProps) {
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  if (credits === null || dismissedFor === credits) return null;

  return (
    <ComposerNote
      data-testid={testId}
      dismissTestId={`${testId}-dismiss`}
      dismissLabel={dismissLabel}
      onDismiss={() => setDismissedFor(credits)}
    >
      <Typography data-testid={`${testId}-text`} sx={{ fontSize: '13px', color: 'text.primary' }}>
        {lead}: about {creditFormat.format(credits)} credits for the next message.
      </Typography>
    </ComposerNote>
  );
}

/** The selected model is not the one holding this conversation's cache. Dismissal lasts for one figure. */
export function ModelSwitchCostNotice({ credits }: { credits: number | null }) {
  return (
    <CacheCostNotice
      credits={credits}
      testId="chat-model-switch-cost-notice"
      dismissLabel="Dismiss model switch cost note"
      lead="Switching models re-reads this conversation"
    />
  );
}
