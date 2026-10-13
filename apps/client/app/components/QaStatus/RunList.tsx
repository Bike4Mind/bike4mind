import { FC, ReactNode, useState } from 'react';
import { Box, Button, Card, Chip, IconButton, Stack, Typography } from '@mui/joy';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import type { QaRunSummary } from '@client/app/hooks/data/qaStatus';
import { formatDuration, formatTime } from './format';
import { dayLabel, groupRuns, isFailingRun, localDayKey } from './runGroups';

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
  const failing = isFailingRun(run);
  return (
    <Box>
      <Stack data-testid="qa-run-row" direction="row" spacing={1.5} alignItems="center" sx={{ py: 0.5 }}>
        {/* Fixed slot so columns line up between failing and passing rows. */}
        <Box sx={{ width: 20, display: 'flex' }}>
          {failing && (
            <ErrorRoundedIcon sx={{ color: 'danger.plainColor' }} fontSize="small" data-testid="qa-run-failed-icon" />
          )}
        </Box>
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
        <Typography
          level="body-sm"
          color={failing ? 'danger' : undefined}
          data-testid="qa-run-counts"
          sx={{ width: 70, fontVariantNumeric: 'tabular-nums' }}
        >
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
        <Box data-testid="qa-run-expanded" sx={{ pl: 9, pb: 1.5 }}>
          {renderExpanded(run)}
        </Box>
      )}
    </Box>
  );
};

interface GroupHeaderProps {
  kind: 'day' | 'suite';
  label: string;
  runCount: number;
  failed: number;
  open: boolean;
  onToggle: () => void;
}

// Failed chip stays visible while collapsed, so failures are never hidden by grouping.
const GroupHeader: FC<GroupHeaderProps> = ({ kind, label, runCount, failed, open, onToggle }) => (
  <Button
    size="sm"
    variant="plain"
    color="neutral"
    data-testid={`qa-${kind}-toggle-btn`}
    aria-expanded={open}
    onClick={onToggle}
    startDecorator={open ? <KeyboardArrowDownIcon /> : <KeyboardArrowRightIcon />}
    sx={{ justifyContent: 'flex-start', gap: 0.5, px: 0.5 }}
  >
    <Typography component="span" level={kind === 'day' ? 'title-sm' : 'body-sm'} fontWeight="lg">
      {label}
    </Typography>
    <Typography component="span" level="body-xs" sx={{ ml: 1 }}>
      {runCount} {runCount === 1 ? 'run' : 'runs'}
    </Typography>
    {failed > 0 && (
      <Chip
        component="span"
        size="sm"
        color="danger"
        variant="soft"
        data-testid={`qa-${kind}-failed-chip`}
        sx={{ ml: 1 }}
      >
        {failed} failed
      </Chip>
    )}
  </Button>
);

const RunList: FC<Props> = ({ runs, onOpenRun, renderExpanded, hasMore, onLoadMore }) => {
  // User toggles only; anything untouched falls back to its default, so it follows the loaded runs.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const days = groupRuns(runs);
  const now = new Date();
  const todayKey = localDayKey(now);
  const defaultDayKey = days.some(d => d.key === todayKey) ? todayKey : days[0]?.key;
  const isOpen = (id: string, fallback: boolean) => toggled[id] ?? fallback;
  const toggle = (id: string, fallback: boolean) => setToggled(t => ({ ...t, [id]: !(t[id] ?? fallback) }));

  return (
    <Card variant="outlined">
      <Typography level="title-sm">Runs</Typography>
      {days.length === 0 && <Typography level="body-sm">No runs match these filters.</Typography>}
      {days.map(day => {
        const dayId = `day:${day.key}`;
        const dayDefault = day.key === defaultDayKey;
        const dayOpen = isOpen(dayId, dayDefault);
        return (
          <Box key={day.key} data-testid="qa-day-group">
            <GroupHeader
              kind="day"
              label={dayLabel(day.date, now)}
              runCount={day.runCount}
              failed={day.failed}
              open={dayOpen}
              onToggle={() => toggle(dayId, dayDefault)}
            />
            {dayOpen &&
              day.suites.map(group => {
                const suiteId = `suite:${day.key}:${group.suite}`;
                const suiteOpen = isOpen(suiteId, true);
                return (
                  <Box key={group.suite} data-testid="qa-suite-group" sx={{ pl: 2 }}>
                    <GroupHeader
                      kind="suite"
                      label={group.suite}
                      runCount={group.runs.length}
                      failed={group.failed}
                      open={suiteOpen}
                      onToggle={() => toggle(suiteId, true)}
                    />
                    {suiteOpen && (
                      <Box sx={{ pl: 2 }}>
                        {group.runs.map(run => (
                          <RunRow key={run.id} run={run} onOpenRun={onOpenRun} renderExpanded={renderExpanded} />
                        ))}
                      </Box>
                    )}
                  </Box>
                );
              })}
          </Box>
        );
      })}
      {hasMore && (
        <Button size="sm" variant="outlined" data-testid="qa-runs-more-btn" onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </Card>
  );
};

export default RunList;
