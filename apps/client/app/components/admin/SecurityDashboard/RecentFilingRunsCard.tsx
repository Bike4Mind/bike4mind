import { Button } from '@mui/joy';
import { useSecopsTriageStatus } from '@client/app/hooks/data/admin';
import type { SecopsTriageRunSummary } from '@client/pages/api/admin/secops-triage/status';
import { DataTable, EmptyState, RelativeTime, SectionCard } from '../shared';
import { describeTriageRun, scanSourceLabel } from './issueFiling';

const TEST_ID = 'security-filing-runs';

type RunRow = SecopsTriageRunSummary & { position: number };

/** The stage's most recent filing runs, newest first, each with its outcome in words. */
export function RecentFilingRunsCard() {
  const { data, isLoading, isError, refetch } = useSecopsTriageStatus();
  const rows: RunRow[] = (data?.recentRuns ?? []).map((run, position) => ({ ...run, position }));

  return (
    <SectionCard title="Recent filing runs" body="custom" data-testid={TEST_ID}>
      <DataTable
        label="Recent filing runs"
        testId={`${TEST_ID}-table`}
        rows={rows}
        getRowId={row => String(row.position)}
        rowTestId={row => `${TEST_ID}-row-${row.position}`}
        loading={!data && isLoading}
        error={!data && isError ? 'Filing runs could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            title="No filing runs yet"
            description="A run is recorded each time a scan sends its findings to be filed."
            action={
              <Button variant="outlined" onClick={() => void refetch()} data-testid={`${TEST_ID}-refresh-btn`}>
                Refresh runs
              </Button>
            }
          />
        }
        pagination={false}
        framed={false}
        minWidth="36rem"
        maxHeight="none"
        columns={[
          { id: 'when', label: 'When', width: '9rem', render: row => <RelativeTime at={row.startedAt} /> },
          { id: 'scan', label: 'Scan', width: '13rem', render: row => scanSourceLabel(row.scanSource) },
          {
            id: 'outcome',
            label: 'Outcome',
            wrap: true,
            render: row => <span data-testid={`${TEST_ID}-outcome`}>{describeTriageRun(row)}</span>,
          },
        ]}
      />
    </SectionCard>
  );
}
