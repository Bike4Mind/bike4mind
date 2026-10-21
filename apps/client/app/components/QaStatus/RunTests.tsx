import { FC, useMemo } from 'react';
import { Button, Card, Chip, Stack, Typography } from '@mui/joy';
import CancelRoundedIcon from '@mui/icons-material/CancelRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import RadioButtonUncheckedRoundedIcon from '@mui/icons-material/RadioButtonUncheckedRounded';
import RemoveCircleOutlineRoundedIcon from '@mui/icons-material/RemoveCircleOutlineRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import type { QaTestView } from '@client/app/hooks/data/qaStatus';
import { formatDelta, formatTestDuration, SLOW_TEST_RATIO } from './format';
import { groupTests } from './testGroups';

const STATUS = {
  passed: { Icon: CheckCircleRoundedIcon, color: 'success' },
  failed: { Icon: CancelRoundedIcon, color: 'danger' },
  flaky: { Icon: WarningAmberRoundedIcon, color: 'warning' },
  skipped: { Icon: RemoveCircleOutlineRoundedIcon, color: 'neutral' },
  notStarted: { Icon: RadioButtonUncheckedRoundedIcon, color: 'neutral' },
} as const;

const TestRow: FC<{ test: QaTestView; onOpenTest: (testKey: string) => void }> = ({ test, onOpenTest }) => {
  const { Icon, color } = STATUS[test.status];
  const slow = test.medianMs !== undefined && test.durationMs >= test.medianMs * SLOW_TEST_RATIO;
  return (
    <Stack data-testid="qa-test-row" data-status={test.status} direction="row" alignItems="center" spacing={1}>
      <Icon fontSize="small" titleAccess={test.status} sx={{ color: `${color}.plainColor` }} />
      <Typography level="body-sm" noWrap title={test.title} sx={{ flex: 1, minWidth: 0 }}>
        {test.title}
      </Typography>
      {test.retries > 0 && <Chip size="sm">{test.retries} retries</Chip>}
      {test.medianMs !== undefined && (
        <Typography
          data-testid="qa-test-delta"
          data-slow={slow}
          level="body-xs"
          color={slow ? 'warning' : 'neutral'}
          sx={{ fontWeight: slow ? 'lg' : undefined }}
        >
          {formatDelta(test.durationMs - test.medianMs, formatTestDuration)} vs 7d median
        </Typography>
      )}
      <Typography data-testid="qa-test-duration" level="body-sm" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatTestDuration(test.durationMs)}
      </Typography>
      <Button size="sm" variant="plain" data-testid="qa-test-history-btn" onClick={() => onOpenTest(test.testKey)}>
        History
      </Button>
    </Stack>
  );
};

/** Every test of the run, by suite file group. Medians are only present on the run's slowest tests. */
const RunTests: FC<{ tests: QaTestView[]; onOpenTest: (testKey: string) => void }> = ({ tests, onOpenTest }) => {
  const groups = useMemo(() => groupTests(tests), [tests]);
  return (
    <Stack data-testid="qa-run-tests" spacing={1}>
      <Typography level="title-md">Tests</Typography>
      {groups.map(g => (
        <Card key={g.name} data-testid="qa-test-group" variant="outlined" size="sm">
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-sm">{g.name}</Typography>
            <Chip size="sm" variant="soft" color={g.failed > 0 ? 'danger' : 'neutral'}>
              {g.tests.length} {g.tests.length === 1 ? 'test' : 'tests'}
              {g.failed > 0 ? `, ${g.failed} failed` : ''}
            </Chip>
          </Stack>
          {g.tests.map(t => (
            <TestRow key={t.testKey} test={t} onOpenTest={onOpenTest} />
          ))}
        </Card>
      ))}
    </Stack>
  );
};

export default RunTests;
