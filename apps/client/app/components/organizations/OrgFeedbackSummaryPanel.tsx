import { type OrgFeedbackRange, useOrgFeedbackReport } from '@client/app/hooks/data/orgFeedbackReport';
import { useOrgFeedbackSummary } from '@client/app/hooks/data/useOrgFeedbackSummary';
import { Alert, Button, Card, CircularProgress, Stack, Typography } from '@mui/joy';
import { FC } from 'react';

/**
 * The written summary for the window the Analysis shell has applied.
 *
 * Shares the shell's range with the counts panel, and reads the counts through the same query key,
 * so the aggregate is fetched once and the two panels cannot disagree about the window.
 */
const OrgFeedbackSummaryPanel: FC<{ organizationId: string; range: OrgFeedbackRange }> = ({
  organizationId,
  range,
}) => {
  const report = useOrgFeedbackReport(organizationId, range, { enabled: true });
  const { data, isLoading, generate } = useOrgFeedbackSummary(organizationId, range);

  const status = data?.status ?? 'none';
  const running = status === 'pending' || status === 'processing';
  // Only once the counts are in: an undefined total is "not loaded yet", not "nothing to say".
  const empty = report.data?.totals.count === 0;

  const body = () => {
    if (empty) {
      return (
        <Typography level="body-md" data-testid="feedback-summary-empty-state">
          No feedback in this period, so there is nothing to summarize.
        </Typography>
      );
    }
    if (running) {
      return (
        <Stack direction="row" spacing={1.5} alignItems="center" data-testid="feedback-summary-pending-spinner">
          <CircularProgress size="sm" />
          <Typography level="body-md">Writing the summary. This takes a moment.</Typography>
        </Stack>
      );
    }
    if (status === 'failed') {
      return (
        <Alert color="danger" data-testid="feedback-summary-error-alert">
          {data?.errorMessage || 'The summary could not be generated.'}
        </Alert>
      );
    }
    if (status === 'completed' && data?.artifact) {
      return (
        <Stack spacing={1}>
          <Typography level="body-xs">
            Covering {data.artifact.range.from.slice(0, 10)} to {data.artifact.range.to.slice(0, 10)}
          </Typography>
          <Typography level="body-md" whiteSpace="pre-wrap" data-testid="feedback-summary-result-text">
            {data.artifact.summary}
          </Typography>
        </Stack>
      );
    }
    return (
      <Typography level="body-md" data-testid="feedback-summary-idle">
        Generate a written read of this window, built from the counts above.
      </Typography>
    );
  };

  return (
    <Card variant="outlined">
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <Typography level="title-md">Summary</Typography>
          <Button
            size="sm"
            data-testid="feedback-summary-generate-button"
            loading={generate.isPending}
            disabled={running || empty || isLoading}
            onClick={() => generate.mutate()}
          >
            {status === 'failed' || status === 'completed' ? 'Regenerate' : 'Generate'}
          </Button>
        </Stack>
        {body()}
      </Stack>
    </Card>
  );
};

export default OrgFeedbackSummaryPanel;
