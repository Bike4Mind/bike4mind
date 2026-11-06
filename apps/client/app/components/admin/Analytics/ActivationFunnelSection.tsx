import { Box, Button, Stack, Typography } from '@mui/joy';
import type { UserFunnelStep } from '@client/app/utils/adminUsersFilter';
import type { ActivationFunnel } from '@client/app/utils/activationFunnel';
import { DataTable, EmptyState, SectionCard, StatusChip, type DataColumn } from '../shared';
import { AnalyticsSection } from './AnalyticsSection';
import { formatCount } from './analyticsFormat';

const STEP_LABELS: Record<UserFunnelStep, string> = {
  signedUp: 'Signed up',
  firstAction: 'First AI action',
  cameBack: 'Came back',
  paid: 'Paid',
};

type Props = {
  data: ActivationFunnel | undefined;
  loading: boolean;
  error: boolean;
  /** The server's reason for refusing this range (a 422), shown instead of an error a retry cannot fix. */
  refused?: string;
  /** The counts are from the previous query while the current one loads, so they must not be acted on. */
  updating?: boolean;
  /** Whether a request is in flight; a disabled query leaves stale counts but nothing loading. */
  fetching?: boolean;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
  /** Opens the Users list for the signups whose furthest step is `step`. */
  onSelectStep: (step: UserFunnelStep) => void;
};

type Row = { step: UserFunnelStep; reached: number; stoppedHere: number; ofPrevious: number | null };

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value)}%`);

export function ActivationFunnelSection({
  data,
  loading,
  error,
  refused,
  updating = false,
  fetching = true,
  onRetry,
  onShowDefaultRange,
  onSelectStep,
}: Props) {
  if (!loading && refused) {
    return (
      <SectionCard title="Activation funnel" body="custom" data-testid="analytics-funnel">
        <EmptyState title="Too many signups to chart" description={refused} action={null} />
      </SectionCard>
    );
  }

  // The previous range's empty states must not stand in for the one now loading.
  const stale = updating && fetching;
  if (!loading && !error && !stale && data?.status === 'rangeTooLong') {
    return (
      <SectionCard title="Activation funnel" body="custom" data-testid="analytics-funnel">
        <EmptyState
          title={`The funnel covers up to ${data.maxDays} days of signups`}
          description="Pick a shorter range to see it."
          action={
            onShowDefaultRange ? (
              <Button variant="outlined" onClick={onShowDefaultRange} data-testid="analytics-funnel-show-90d-btn">
                Show last 90 days
              </Button>
            ) : null
          }
        />
      </SectionCard>
    );
  }

  const ok = data?.status === 'ok' ? data : undefined;
  const allTooNew = !!ok && ok.steps[0].reached === 0 && ok.tooNew > 0;
  if (!loading && !error && !stale && allTooNew) {
    return (
      <SectionCard title="Activation funnel" body="custom" data-testid="analytics-funnel">
        <EmptyState
          title={`${formatCount(ok.tooNew)} ${ok.tooNew === 1 ? 'signup is' : 'signups are'} too new to judge`}
          description="A signup needs 7 days to show whether it activated. Check back once they are a week old."
          action={
            onShowDefaultRange ? (
              <Button variant="outlined" onClick={onShowDefaultRange} data-testid="analytics-funnel-show-90d-btn">
                Show last 90 days
              </Button>
            ) : null
          }
        />
      </SectionCard>
    );
  }
  const rows: Row[] = (ok?.steps ?? []).map((step, index, steps) => ({
    ...step,
    ofPrevious: index === 0 || steps[index - 1].reached === 0 ? null : (step.reached / steps[index - 1].reached) * 100,
  }));
  const top = rows[0]?.reached ?? 0;
  const judged = formatCount(top);
  const caption = ok
    ? `${judged} ${top === 1 ? 'signup' : 'signups'} at least 7 days old; ${formatCount(ok.tooNew)} too new to judge. Click a step to list who stopped there.`
    : undefined;
  const summary = rows
    .map(
      row =>
        `${STEP_LABELS[row.step]}: ${formatCount(row.reached)}${row.ofPrevious === null ? '' : ` (${percent(row.ofPrevious)} of previous)`}`
    )
    .join('. ');

  const chart = (
    <Stack gap={1.25} role="group" aria-label={`Activation funnel. ${summary}`} data-testid="analytics-funnel-chart">
      {rows.map(row => (
        <Box key={row.step}>
          <Stack direction="row" justifyContent="space-between" alignItems="baseline" gap={1} flexWrap="wrap">
            <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
              {STEP_LABELS[row.step]}
              {row.step === 'paid' && ok?.paidPending && (
                <Box component="span" sx={{ ml: 1 }}>
                  <StatusChip tone="warn" label="Pending" data-testid="analytics-funnel-paid-pending-chip" />
                </Box>
              )}
            </Typography>
            <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
              {formatCount(row.reached)}
              {row.ofPrevious !== null && (
                <Box
                  component="span"
                  sx={{ color: 'admin.inkMuted' }}
                >{` \u00b7 ${percent(row.ofPrevious)} of previous`}</Box>
              )}
            </Typography>
          </Stack>
          <Box
            aria-hidden
            sx={{ height: 10, my: 0.5, borderRadius: '5px', bgcolor: 'admin.hover', overflow: 'hidden' }}
          >
            <Box
              style={{ width: `${row.reached > 0 && top > 0 ? Math.max((row.reached / top) * 100, 2) : 0}%` }}
              sx={{ height: '100%', borderRadius: '5px', bgcolor: 'admin.accent' }}
            />
          </Box>
          <Button
            size="sm"
            variant="plain"
            disabled={row.stoppedHere === 0 || updating}
            aria-label={`${formatCount(row.stoppedHere)} stopped here: list the ${row.stoppedHere === 1 ? 'signup' : 'signups'} who stopped at ${STEP_LABELS[row.step]}`}
            onClick={() => onSelectStep(row.step)}
            data-testid={`analytics-funnel-step-${row.step}-btn`}
            sx={{ px: 0, minHeight: 0 }}
          >
            {`${formatCount(row.stoppedHere)} stopped here`}
          </Button>
        </Box>
      ))}
      {updating && fetching && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="analytics-funnel-updating">
          Updating...
        </Typography>
      )}
      {ok?.paidPending && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Some signups are under 30 days old; paid is still counting.
        </Typography>
      )}
    </Stack>
  );

  const columns: DataColumn<Row>[] = [
    { id: 'step', label: 'Step', render: row => STEP_LABELS[row.step] },
    { id: 'reached', label: 'Reached', numeric: true, render: row => formatCount(row.reached) },
    { id: 'ofPrevious', label: '% of previous', numeric: true, render: row => percent(row.ofPrevious) },
    { id: 'stoppedHere', label: 'Stopped here', numeric: true, render: row => formatCount(row.stoppedHere) },
  ];
  const table = (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={row => row.step}
      label="Activation funnel steps"
      onRetry={onRetry}
      pagination={false}
      testId="analytics-funnel-table"
    />
  );

  return (
    <AnalyticsSection
      title="Activation funnel"
      caption={caption}
      loading={loading || (stale && (!ok || allTooNew))}
      error={error}
      onRetry={onRetry}
      empty={!!ok && top === 0}
      onShowDefaultRange={onShowDefaultRange}
      chart={chart}
      table={table}
      testId="analytics-funnel"
    />
  );
}
