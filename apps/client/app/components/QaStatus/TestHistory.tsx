import { FC } from 'react';
import { Card, Chip, Table, Typography } from '@mui/joy';
import type { QaTestHistory } from '@client/app/hooks/data/qaStatus';
import { formatDuration, formatTime, stateLabel } from './format';

const COLOR = {
  passed: 'success',
  failed: 'danger',
  flaky: 'warning',
  skipped: 'neutral',
  notStarted: 'neutral',
} as const;

const TestHistory: FC<{ history: QaTestHistory; onOpenRun: (runId: string) => void }> = ({ history, onOpenRun }) => (
  <Card variant="outlined">
    <Typography level="h4">{history.title}</Typography>
    <Typography level="body-xs" sx={{ fontFamily: 'code' }}>
      {history.testKey}
    </Typography>
    <Typography data-testid="qa-test-flake" level="body-sm">
      failed {history.flake.failures}/{history.flake.total} ({Math.round(history.flake.rate * 100)}%) over the last{' '}
      {history.flake.total} results that ran
    </Typography>
    <Table size="sm" hoverRow>
      <tbody>
        {history.rows.map((r, i) => (
          <tr
            key={`${r.runId}-${i}`}
            data-testid="qa-test-history-row"
            onClick={() => onOpenRun(r.runId)}
            style={{ cursor: 'pointer' }}
          >
            <td style={{ width: 120 }}>{formatTime(r.startedAt)}</td>
            <td>
              <Chip size="sm" variant="soft" color={COLOR[r.status]}>
                {r.status}
              </Chip>
            </td>
            <td>
              {stateLabel(r)} . {r.branch}
            </td>
            <td style={{ textAlign: 'right' }}>{formatDuration(r.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  </Card>
);

export default TestHistory;
