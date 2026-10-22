import { FC } from 'react';
import { Box, Button, Card, Chip, Link, Stack, Typography } from '@mui/joy';
import type { QaMediaView, QaRunDetail, QaTestView } from '@client/app/hooks/data/qaStatus';
import { commitUrl, formatDelta, formatDuration, formatTime, stateLabel } from './format';
import RunDiff from './RunDiff';
import RunTests from './RunTests';

const TRACE_HINT = 'npx playwright show-trace trace.zip';

const Media: FC<{ media: QaMediaView; compact: boolean }> = ({ media, compact }) => {
  const testId = `qa-media-${media.kind}`;
  if (media.state !== 'ok' || !media.url) {
    return (
      <Chip data-testid={testId} size="sm" variant="outlined">
        {media.kind} {media.state}
      </Chip>
    );
  }
  if (media.kind === 'screenshot') {
    return (
      <Box data-testid={testId} component="a" href={media.url} target="_blank" rel="noreferrer">
        <img src={media.url} alt="Failure screenshot" style={{ maxWidth: compact ? 160 : 480, borderRadius: 4 }} />
      </Box>
    );
  }
  if (media.kind === 'video') {
    return compact ? (
      <Link data-testid={testId} href={media.url} target="_blank" rel="noreferrer" level="body-sm">
        video
      </Link>
    ) : (
      <Box data-testid={testId}>
        <video src={media.url} controls style={{ maxWidth: 480 }} />
      </Box>
    );
  }
  // A download, not trace.playwright.dev: that would need bucket CORS for its origin.
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Link data-testid={testId} href={media.url} download level="body-sm" title={`Open with: ${TRACE_HINT}`}>
        trace.zip
      </Link>
      {!compact && (
        <Typography level="body-xs" sx={{ fontFamily: 'code' }}>
          {TRACE_HINT}
        </Typography>
      )}
    </Stack>
  );
};

const TestCard: FC<{ test: QaTestView; compact: boolean; onOpenTest: (k: string) => void }> = ({
  test,
  compact,
  onOpenTest,
}) => (
  <Card data-testid="qa-failed-test" variant="soft" color={test.status === 'failed' ? 'danger' : 'warning'}>
    <Stack direction="row" alignItems="center" spacing={1}>
      <Typography level="title-sm">{test.title}</Typography>
      {test.retries > 0 && <Chip size="sm">{test.retries} retries</Chip>}
      <Button
        size="sm"
        variant="plain"
        sx={{ ml: 'auto' }}
        data-testid="qa-failed-test-history-btn"
        onClick={() => onOpenTest(test.testKey)}
      >
        History
      </Button>
    </Stack>
    {test.error && !compact && (
      <Typography component="pre" level="body-xs" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'code', m: 0 }}>
        {test.error}
      </Typography>
    )}
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
      {test.media.map((m, i) => (
        <Media key={`${m.kind}-${i}`} media={m} compact={compact} />
      ))}
    </Stack>
  </Card>
);

interface Props {
  detail: QaRunDetail;
  onOpenTest: (testKey: string) => void;
  /** Opens the previous run linked from the diff; without it the link is plain text. */
  onOpenRun?: (runId: string) => void;
  /** Inline expansion in the run list: thumbnails, no error bodies. */
  compact?: boolean;
}

const RunDetail: FC<Props> = ({ detail, onOpenTest, onOpenRun, compact = false }) => {
  const { run, report, medianDurationMs } = detail;
  const shaUrl = commitUrl(run.ciRunUrl, run.sha);
  return (
    <Stack spacing={2}>
      {!compact && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="h4">{stateLabel(run)}</Typography>
          <Chip color={run.status === 'passed' ? 'success' : run.status === 'failed' ? 'danger' : 'warning'}>
            {run.status}
          </Chip>
          {run.source === 'slack-backfill' && (
            <Chip variant="outlined" data-testid="qa-run-slack-chip">
              from Slack
            </Chip>
          )}
          <Typography level="body-sm">
            {formatTime(run.startedAt)} . {run.branch} . {run.counts.passed}/{run.counts.ran} .{' '}
            <span data-testid="qa-run-duration">
              {formatDuration(run.durationMs)}
              {medianDurationMs !== null && run.durationMs > 0
                ? ` (${formatDelta(run.durationMs - medianDurationMs, formatDuration)} vs 7d median)`
                : ''}
            </span>
          </Typography>
          <Typography data-testid="qa-run-trigger" level="body-sm">
            {run.trigger}
          </Typography>
          {run.sha &&
            (shaUrl ? (
              <Link
                data-testid="qa-run-sha"
                href={shaUrl}
                target="_blank"
                rel="noreferrer"
                level="body-sm"
                sx={{ fontFamily: 'code' }}
              >
                {run.sha.slice(0, 7)}
              </Link>
            ) : (
              <Typography data-testid="qa-run-sha" level="body-sm" sx={{ fontFamily: 'code' }}>
                {run.sha.slice(0, 7)}
              </Typography>
            ))}
          <Link href={run.ciRunUrl} target="_blank" rel="noreferrer" level="body-sm">
            CI run
          </Link>
          {report.state === 'ok' && report.url ? (
            <Link data-testid="qa-run-report-link" href={report.url} target="_blank" rel="noreferrer" level="body-sm">
              Playwright report
            </Link>
          ) : report.state !== 'none' ? (
            <Chip data-testid="qa-run-report-state" size="sm" variant="outlined">
              report {report.state}
            </Chip>
          ) : null}
        </Stack>
      )}
      {run.suiteSummary.length > 0 && (
        <Stack data-testid="qa-run-suites" direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {run.suiteSummary.map(s => (
            <Chip
              key={s.name}
              size="sm"
              variant="soft"
              color={s.passed === s.ran && s.notRun === 0 ? 'success' : 'danger'}
            >
              {s.name} {s.passed}/{s.ran}
              {s.notRun > 0 ? ` (${s.notRun} did not run)` : ''}
            </Chip>
          ))}
        </Stack>
      )}
      {run.source === 'slack-backfill' && (
        <Typography data-testid="qa-run-backfill-note" level="body-sm" sx={{ color: 'text.tertiary' }}>
          Imported from Slack: counts only, no per-test data
        </Typography>
      )}
      {!compact && run.metrics.length > 0 && (
        <Stack data-testid="qa-run-metrics" direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {run.metrics.map((m, i) => (
            <Chip
              key={`${m.kind}-${m.model}-${m.label ?? ''}-${i}`}
              size="sm"
              variant="outlined"
              color={m.threshold !== undefined && m.value > m.threshold ? 'danger' : 'neutral'}
            >
              {m.kind} {m.model}
              {m.label ? ` (${m.label})` : ''}: {m.value} {m.unit}
            </Chip>
          ))}
        </Stack>
      )}
      {!compact && detail.diff && <RunDiff diff={detail.diff} onOpenTest={onOpenTest} onOpenRun={onOpenRun} />}
      {detail.failedTests.map((t, i) => (
        <TestCard key={`${t.testKey}-${i}`} test={t} compact={compact} onOpenTest={onOpenTest} />
      ))}
      {!compact && detail.flakyTests.length > 0 && (
        <>
          <Typography level="title-sm">Passed on retry</Typography>
          {detail.flakyTests.map((t, i) => (
            <TestCard key={`${t.testKey}-${i}`} test={t} compact={compact} onOpenTest={onOpenTest} />
          ))}
        </>
      )}
      {!compact && detail.tests.length > 0 && <RunTests tests={detail.tests} onOpenTest={onOpenTest} />}
    </Stack>
  );
};

export default RunDetail;
