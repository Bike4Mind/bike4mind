import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { useState } from 'react';
import type { WatchDecision, WatchPending } from '@shared/watch';

/**
 * The oldest request waiting on the user, from any orchestration. Quick ones are answered here;
 * anything riskier only offers to open the app, where the full approval card lives.
 */
export function NeedsYouCard({
  pending,
  more,
  onRespond,
  onReview,
}: {
  pending: WatchPending;
  /** How many more are waiting behind this one. */
  more: number;
  onRespond(approvalId: string, decision: WatchDecision): Promise<boolean>;
  onReview(pending: WatchPending): void;
}) {
  const [busy, setBusy] = useState(false);
  const respond = async (decision: WatchDecision) => {
    setBusy(true);
    try {
      // A refusal means it was answered elsewhere or is no longer quick; the next snapshot shows which.
      await onRespond(pending.approvalId, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      role="group"
      aria-label={`${pending.agentTitle} needs you`}
      data-testid="mini-needs-you-card"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        p: 1,
        borderRadius: 'sm',
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'warning.outlinedBorder',
        boxShadow: 'sm',
      }}
    >
      <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="mini-needs-you-orchestration">
        {pending.orchestrationTitle}
        {more > 0 ? ` (+${more} more)` : ''}
      </Typography>
      <Typography level="body-sm" fontWeight="lg" noWrap>
        {pending.agentTitle}
      </Typography>
      <Typography level="body-xs" noWrap sx={{ fontFamily: 'code' }} data-testid="mini-needs-you-summary">
        {pending.summary}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
        {pending.quick ? (
          <>
            <Button
              size="sm"
              color="primary"
              disabled={busy}
              onClick={() => void respond('once')}
              data-testid="mini-needs-you-approve-btn"
            >
              Approve once
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={busy}
              onClick={() => void respond('deny')}
              data-testid="mini-needs-you-deny-btn"
            >
              Deny
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="soft"
            color="warning"
            onClick={() => onReview(pending)}
            data-testid="mini-needs-you-review-btn"
          >
            Review in app
          </Button>
        )}
      </Box>
    </Box>
  );
}
