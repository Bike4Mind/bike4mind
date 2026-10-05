import { FC } from 'react';
import { Chip, Link, Stack, Typography } from '@mui/joy';
import type { QaRunDiff } from '@client/app/hooks/data/qaStatus';
import { formatTime } from './format';

const LISTS = [
  { key: 'newlyFailing', testId: 'newly-failing', label: 'Newly failing', color: 'danger' },
  { key: 'recovered', testId: 'recovered', label: 'Recovered', color: 'success' },
  { key: 'added', testId: 'added', label: 'Added', color: 'neutral' },
  { key: 'removed', testId: 'removed', label: 'Removed', color: 'neutral' },
] as const;

const MAX_SHOWN = 10;

interface Props {
  diff: QaRunDiff;
  onOpenTest: (testKey: string) => void;
  onOpenRun?: (runId: string) => void;
}

const RunDiff: FC<Props> = ({ diff, onOpenTest, onOpenRun }) => {
  const lists = LISTS.filter(l => diff[l.key].length > 0);
  const previous = formatTime(diff.previousStartedAt);
  return (
    <Stack data-testid="qa-run-diff" spacing={1}>
      <Stack direction="row" spacing={1} alignItems="baseline">
        <Typography level="title-md">Since previous run</Typography>
        {onOpenRun ? (
          <Link
            component="button"
            level="body-sm"
            data-testid="qa-run-diff-prev-link"
            onClick={() => onOpenRun(diff.previousRunId)}
          >
            {previous}
          </Link>
        ) : (
          <Typography level="body-sm">{previous}</Typography>
        )}
      </Stack>
      {lists.length === 0 && (
        <Typography data-testid="qa-run-diff-empty" level="body-sm">
          No changes since previous run
        </Typography>
      )}
      {lists.map(l => (
        <Stack key={l.key} data-testid={`qa-run-diff-${l.testId}`} spacing={0.5}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography level="title-sm">{l.label}</Typography>
            <Chip size="sm" variant="soft" color={l.color}>
              {diff[l.key].length}
            </Chip>
          </Stack>
          {diff[l.key].slice(0, MAX_SHOWN).map(t => (
            <Link
              key={t.testKey}
              component="button"
              level="body-sm"
              data-testid="qa-run-diff-test"
              sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => onOpenTest(t.testKey)}
            >
              {t.title}
            </Link>
          ))}
          {diff[l.key].length > MAX_SHOWN && (
            <Typography level="body-xs">and {diff[l.key].length - MAX_SHOWN} more</Typography>
          )}
        </Stack>
      ))}
    </Stack>
  );
};

export default RunDiff;
