import { FC, ReactNode, useState } from 'react';
import { Box, Button, Card, Chip, IconButton, Stack, Typography } from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';
import { formatDuration, formatTime } from './format';

interface Props {
  runs: QaRunSummary[];
  onOpenRun: (runId: string) => void;
  /** Rendered only while a row is expanded, so it can fetch lazily. */
  renderExpanded: (run: QaRunSummary) => ReactNode;
  hasMore: boolean;
  onLoadMore: () => void;
}

const RunRow: FC<{ run: QaRunSummary } & Pick<Props, 'onOpenRun' | 'renderExpanded'>> = ({
  run,
  onOpenRun,
  renderExpanded,
}) => {
  const [open, setOpen] = useState(false);
  const { counts } = run;
  return (
    <Box>
      <Stack data-testid="qa-run-row" direction="row" spacing={1.5} alignItems="center" sx={{ py: 0.5 }}>
        <IconButton
          size="sm"
          data-testid="qa-run-expand-btn"
          onClick={() => setOpen(o => !o)}
          aria-label={open ? 'Collapse run' : 'Expand run'}
        >
          {open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
        </IconButton>
        <Typography level="body-sm" sx={{ width: 110, fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(run.startedAt)}
        </Typography>
        <Typography level="body-sm" sx={{ width: 120 }}>
          {run.suite}
        </Typography>
        <Typography level="body-sm" sx={{ width: 110 }}>
          {run.env}
          {run.tenant ? ` (${run.tenant})` : ''}
        </Typography>
        <Typography level="body-sm" sx={{ width: 70, fontVariantNumeric: 'tabular-nums' }}>
          {counts.passed}/{counts.ran}
        </Typography>
        {counts.failed > 0 && (
          <Chip size="sm" color="danger" variant="soft">
            {counts.failed} failed
          </Chip>
        )}
        {run.status === 'infra-error' && (
          <Chip size="sm" color="warning" variant="soft" data-testid="qa-run-env-down-chip">
            env down: {counts.ran} of {counts.ran + counts.notStarted} ran
          </Chip>
        )}
        {run.source === 'slack-backfill' && (
          <Chip size="sm" variant="outlined" data-testid="qa-run-slack-chip">
            from Slack
          </Chip>
        )}
        <Typography level="body-sm" sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          {formatDuration(run.durationMs)}
        </Typography>
        <Button size="sm" variant="plain" data-testid="qa-run-open-btn" onClick={() => onOpenRun(run.id)}>
          Open
        </Button>
      </Stack>
      {open && (
        <Box data-testid="qa-run-expanded" sx={{ pl: 6, pb: 1.5 }}>
          {renderExpanded(run)}
        </Box>
      )}
    </Box>
  );
};

const RunList: FC<Props> = ({ runs, onOpenRun, renderExpanded, hasMore, onLoadMore }) => (
  <Card variant="outlined">
    <Typography level="title-sm">Runs</Typography>
    {runs.length === 0 && <Typography level="body-sm">No runs match these filters.</Typography>}
    {runs.map(run => (
      <RunRow key={run.id} run={run} onOpenRun={onOpenRun} renderExpanded={renderExpanded} />
    ))}
    {hasMore && (
      <Button size="sm" variant="outlined" data-testid="qa-runs-more-btn" onClick={onLoadMore}>
        Load more
      </Button>
    )}
  </Card>
);

export default RunList;
