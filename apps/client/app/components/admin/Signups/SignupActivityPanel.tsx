import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  LinearProgress,
  Option,
  Select,
  Sheet,
  Stack,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import {
  SIGNUP_SIGNAL_LABELS,
  SIGNUP_SIGNALS,
  SIGNUP_TIMESERIES_RANGE_LABELS as RANGE_LABELS,
  SIGNUP_TIMESERIES_RANGES,
  type SignupTimeseriesBucket,
  type SignupTimeseriesRange,
} from '@client/app/utils/signupSignals';
import { adminSurface } from '../shared/adminStyles';
import { DataTable } from '../shared/DataTable';
import { SignupChart, type SignupChartMode } from './SignupChart';
import { bucketWindow, formatBucketLabel, useSignupTimeseries } from './useSignupTimeseries';

const topSignals = (bucket: SignupTimeseriesBucket) =>
  SIGNUP_SIGNALS.filter(signal => bucket.bySignal[signal] > 0)
    .sort((a, b) => bucket.bySignal[b] - bucket.bySignal[a])
    .slice(0, 2)
    .map(signal => `${SIGNUP_SIGNAL_LABELS[signal].label} (${bucket.bySignal[signal].toLocaleString()})`)
    .join(', ');

/**
 * The Users tab's signup chart. Picking a period (a bar, or a row of the table view) filters the user
 * list to accounts created in it, where the existing review and bulk abuse tools take over.
 */
export function SignupActivityPanel({
  range,
  onRangeChange,
  onSelectWindow,
}: {
  /** Owned by the Users tab, so the list's Verdict column classifies under the same range. */
  range: SignupTimeseriesRange;
  onRangeChange: (range: SignupTimeseriesRange) => void;
  onSelectWindow: (window: { createdFrom: string; createdTo: string }) => void;
}) {
  const [mode, setMode] = useState<SignupChartMode>('status');
  const [showBaseline, setShowBaseline] = useState(true);
  const [showTable, setShowTable] = useState(false);
  const query = useSignupTimeseries(range);
  const data = query.data;
  const selectBucket = (start: string) => data && onSelectWindow(bucketWindow(start, data.bucket));

  return (
    <Sheet variant="outlined" sx={{ ...adminSurface, p: 2 }} data-testid="users-signup-panel">
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5}>
        <Box>
          <Typography level="title-md">Signups over time</Typography>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="users-signup-summary">
            {data
              ? `${data.totals.total.toLocaleString()} signups: ${data.totals.likelyLegit.toLocaleString()} likely legit, ${data.totals.suspected.toLocaleString()} suspected. Select a bar to list those accounts.`
              : 'Signups split by the suspected-account signals.'}
          </Typography>
        </Box>
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          <Select
            size="sm"
            aria-label="Time range"
            data-testid="users-signup-range"
            value={range}
            onChange={(_, value) => value && onRangeChange(value)}
          >
            {SIGNUP_TIMESERIES_RANGES.map(option => (
              <Option key={option} value={option}>
                {RANGE_LABELS[option]}
              </Option>
            ))}
          </Select>
          <ToggleButtonGroup
            size="sm"
            aria-label="Chart breakdown"
            value={mode}
            onChange={(_, value) => value && setMode(value)}
          >
            <Button value="status" data-testid="users-signup-mode-status">
              Legit vs suspected
            </Button>
            <Button value="signals" data-testid="users-signup-mode-signals">
              By signal
            </Button>
          </ToggleButtonGroup>
          <Checkbox
            size="sm"
            label="Typical range"
            checked={showBaseline}
            onChange={event => setShowBaseline(event.target.checked)}
            slotProps={{ input: { 'data-testid': 'users-signup-baseline-toggle' } }}
          />
          <Button
            size="sm"
            variant="plain"
            onClick={() => setShowTable(current => !current)}
            data-testid="users-signup-table-toggle"
          >
            {showTable ? 'Hide table' : 'Show table'}
          </Button>
        </Stack>
      </Stack>

      {query.isLoading && <LinearProgress aria-label="Loading signups" sx={{ mt: 2 }} />}
      {query.isError && (
        <Alert
          color="danger"
          sx={{ mt: 2 }}
          endDecorator={
            <Button size="sm" variant="outlined" onClick={() => query.refetch()} data-testid="users-signup-retry-btn">
              Retry
            </Button>
          }
        >
          Could not load signups.
        </Alert>
      )}
      {data && (
        <Stack gap={1} sx={{ mt: 2 }}>
          {data.truncated && (
            <Alert color="warning" size="sm">
              Only the newest signups in this range were classified; older ones are shown as not classified.
            </Alert>
          )}
          {data.keysTruncated && (
            <Alert color="warning" size="sm">
              API key scan limit reached; the API key signal is a lower bound.
            </Alert>
          )}
          <SignupChart
            data={data}
            mode={mode}
            showBaseline={showBaseline}
            onBucketClick={selectBucket}
            height={200}
            testId="users-signup-chart"
          />
          {mode === 'signals' && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              One account can trigger several signals, so the lines do not add up to the suspected count. An account is
              suspected with a domain burst, machine-regular cadence or bot traffic, or with any two other signals.
            </Typography>
          )}
          {showTable && (
            <DataTable
              rows={[...data.buckets].reverse().filter(bucket => bucket.total > 0)}
              getRowId={bucket => bucket.start}
              label="Signups by period"
              onRetry={() => query.refetch()}
              testId="users-signup-table"
              empty={<Typography level="body-sm">No signups in this range.</Typography>}
              columns={[
                {
                  id: 'period',
                  label: 'Period',
                  render: bucket => formatBucketLabel(bucket.start, data.bucket),
                  sortValue: bucket => bucket.start,
                },
                {
                  id: 'total',
                  label: 'Signups',
                  numeric: true,
                  render: bucket => bucket.total.toLocaleString(),
                  sortValue: bucket => bucket.total,
                },
                {
                  id: 'legit',
                  label: 'Likely legit',
                  numeric: true,
                  render: bucket => bucket.likelyLegit.toLocaleString(),
                  sortValue: bucket => bucket.likelyLegit,
                },
                {
                  id: 'suspected',
                  label: 'Suspected',
                  numeric: true,
                  render: bucket => bucket.suspected.toLocaleString(),
                  sortValue: bucket => bucket.suspected,
                },
                { id: 'signals', label: 'Top signals', render: bucket => topSignals(bucket) || 'None' },
                {
                  id: 'action',
                  label: 'Accounts',
                  render: bucket => (
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => selectBucket(bucket.start)}
                      data-testid={`users-signup-bucket-filter-${bucket.start}`}
                    >
                      Show accounts
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Stack>
      )}
    </Sheet>
  );
}
