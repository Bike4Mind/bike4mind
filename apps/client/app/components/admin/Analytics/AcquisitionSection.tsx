import { Box, Button, Stack, Typography } from '@mui/joy';
import {
  ACQUISITION_NONE,
  ACQUISITION_UNATTRIBUTED_LABEL,
  type AcquisitionConversion,
  type AcquisitionRow,
} from '@client/app/utils/acquisitionConversion';
import { DataTable, EmptyState, SectionCard, SegmentedControl, StatusChip, type DataColumn } from '../shared';
import { AnalyticsSection } from './AnalyticsSection';
import { formatCount, formatPercent } from './analyticsFormat';
import type { AcquisitionControls } from './analyticsTabSearch';

const TITLE = 'Acquisition & conversion';
const TOUCH_OPTIONS = [
  { value: 'first', label: 'First touch' },
  { value: 'last', label: 'Last touch' },
] as const;
const WINDOW_OPTIONS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
] as const;
const FOLLOW_UP_OPTIONS = [
  { value: '30', label: '30d' },
  { value: '60', label: '60d' },
  { value: '90', label: '90d' },
] as const;

type Props = {
  data: AcquisitionConversion | undefined;
  loading: boolean;
  error: boolean;
  /** The server's reason for refusing this range (a 422), shown instead of an error a retry cannot fix. */
  refused?: string;
  /** The request ran out of time (a 504); a narrower range is the fix, though a retry may also land. */
  timedOut?: boolean;
  /** The rows are from the previous query while the current one loads. */
  updating?: boolean;
  fetching?: boolean;
  controls: AcquisitionControls;
  onControlsChange: (patch: Partial<AcquisitionControls>) => void;
  onRetry: () => void;
  onShowDefaultRange?: () => void;
  /** Opens the Users list for the row's signups, or with `converted` only those who converted. */
  onSelectRow?: (row: AcquisitionRow, converted: boolean) => void;
};

const part = (value: string | null) => (value === null || value === ACQUISITION_NONE ? null : value);

function rowLabel(row: AcquisitionRow): { title: string; detail: string | null } {
  if (row.kind === 'unattributed') return { title: ACQUISITION_UNATTRIBUTED_LABEL, detail: null };
  if (row.kind === 'other') return { title: 'Other campaigns', detail: 'Outside the top rows' };
  const detail = [part(row.medium), part(row.campaign)].filter(Boolean).join(' / ');
  return { title: row.source ?? '', detail: detail || null };
}

function SourceCell({ row }: { row: AcquisitionRow }) {
  const { title, detail } = rowLabel(row);
  const full = detail ? `${title} / ${detail}` : title;
  return (
    <Box sx={{ minWidth: 0, maxWidth: 280 }} title={full}>
      <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink', fontWeight: 500 }}>
          {title}
        </Typography>
        {row.provisional && (
          <StatusChip tone="warn" label="Provisional" data-testid={`acquisition-row-${row.key}-provisional-chip`} />
        )}
      </Stack>
      {detail && (
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {detail}
        </Typography>
      )}
    </Box>
  );
}

const renewedCell = (row: AcquisitionRow) =>
  row.renewalDue === 0 && row.renewalUnavailable === 0
    ? '-'
    : `${formatCount(row.renewed)} of ${formatCount(row.renewalDue)}${
        row.renewalUnavailable > 0 ? ` (${formatCount(row.renewalUnavailable)} unknown)` : ''
      }`;

const columnsOf = (onSelectRow: Props['onSelectRow'], updating: boolean): DataColumn<AcquisitionRow>[] => [
  { id: 'source', label: 'Source / medium / campaign', render: row => <SourceCell row={row} /> },
  { id: 'signups', label: 'Signups', numeric: true, render: row => formatCount(row.signups) },
  {
    id: 'firstAction',
    label: 'First action',
    numeric: true,
    help: 'Signups with AI activity in their first week, by the activation funnel rules, out of the signups at least a week old.',
    render: row => `${formatCount(row.firstAction)} of ${formatCount(row.activationSignups)}`,
  },
  {
    id: 'cameBack',
    label: 'Came back',
    numeric: true,
    help: 'Of the signups with a first action, the ones active again on a later day of their first week.',
    render: row => `${formatCount(row.cameBack)} of ${formatCount(row.firstAction)}`,
  },
  {
    id: 'converted',
    label: 'Converted',
    numeric: true,
    help: 'Signups whose conversion window has closed and who paid personally inside it. Pending: newer signups who already paid.',
    render: row =>
      row.provisionalConverted > 0
        ? `${formatCount(row.converted)} (+${formatCount(row.provisionalConverted)} pending)`
        : formatCount(row.converted),
  },
  { id: 'rate', label: 'Rate', numeric: true, render: row => formatPercent(row.conversionPct) },
  { id: 'subscriptionFirst', label: 'Sub first', numeric: true, render: row => formatCount(row.subscriptionFirst) },
  { id: 'creditFirst', label: 'Credits first', numeric: true, render: row => formatCount(row.creditFirst) },
  {
    id: 'both',
    label: 'Both',
    numeric: true,
    help: 'Buyers who paid for both a subscription and credits inside the window; already in the two columns before.',
    render: row => formatCount(row.both),
  },
  {
    id: 'repeatCredit',
    label: 'Repeat credits',
    numeric: true,
    help: 'Buyers past their follow-up period with two or more kept credit purchases inside it.',
    render: row => `${formatCount(row.repeatCredit)} of ${formatCount(row.followUpBuyers)}`,
  },
  {
    id: 'renewed',
    label: 'Renewed',
    numeric: true,
    help: "Derived from each subscription's current state, not an invoice history. Unknown: no billing interval or period start recorded.",
    render: renewedCell,
  },
  {
    id: 'retained',
    label: 'Retained',
    numeric: true,
    help: 'Converted buyers still holding a payment that was not refunded or disputed.',
    render: row => formatCount(row.retained),
  },
  {
    id: 'orgBuyers',
    label: 'Org buyers',
    numeric: true,
    help: 'Signups whose own organization was paid for inside the window; not part of the rate.',
    render: row => formatCount(row.orgBuyers),
  },
  ...(onSelectRow
    ? [
        {
          id: 'drill',
          label: 'Users',
          render: (row: AcquisitionRow) =>
            row.kind === 'other' ? null : (
              <Stack direction="row" gap={0.5}>
                <Button
                  size="sm"
                  variant="plain"
                  disabled={updating || row.signups === 0}
                  aria-label={`List the ${formatCount(row.signups)} signups in ${rowLabel(row).title}`}
                  onClick={() => onSelectRow(row, false)}
                  data-testid={`acquisition-row-${row.key}-drill-btn`}
                  sx={{ px: 0.5, minHeight: 0 }}
                >
                  Signups
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  disabled={updating || row.converted === 0}
                  aria-label={`List the ${formatCount(row.converted)} converted signups in ${rowLabel(row).title}`}
                  onClick={() => onSelectRow(row, true)}
                  data-testid={`acquisition-row-${row.key}-drill-converted-btn`}
                  sx={{ px: 0.5, minHeight: 0 }}
                >
                  Converted
                </Button>
              </Stack>
            ),
        } satisfies DataColumn<AcquisitionRow>,
      ]
    : []),
];

export function AcquisitionSection({
  data,
  loading,
  error,
  refused,
  timedOut = false,
  updating = false,
  fetching = true,
  controls,
  onControlsChange,
  onRetry,
  onShowDefaultRange,
  onSelectRow,
}: Props) {
  const controlBar = (
    <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" data-testid="acquisition-section-controls">
      <SegmentedControl
        options={TOUCH_OPTIONS}
        value={controls.touch}
        onChange={touch => onControlsChange({ touch })}
        aria-label="Attribution touch"
        data-testid="acquisition-touch-toggle"
      />
      <SegmentedControl
        options={WINDOW_OPTIONS}
        value={controls.window}
        onChange={window => onControlsChange({ window })}
        aria-label="Conversion window"
        data-testid="acquisition-window"
      />
      <SegmentedControl
        options={FOLLOW_UP_OPTIONS}
        value={controls.followUp}
        onChange={followUp => onControlsChange({ followUp })}
        aria-label="Follow-up period"
        data-testid="acquisition-follow-up"
      />
    </Stack>
  );

  const notice = (title: string, description: string, testId: string) => (
    <SectionCard title={TITLE} body="custom" data-testid="acquisition-section">
      <Stack gap={2}>
        {controlBar}
        <EmptyState
          title={title}
          description={description}
          action={
            onShowDefaultRange ? (
              <Button
                variant="outlined"
                onClick={onShowDefaultRange}
                data-testid={`acquisition-section-${testId}-90d-btn`}
              >
                Show last 90 days
              </Button>
            ) : null
          }
        />
      </Stack>
    </SectionCard>
  );

  if (!loading && refused) return notice('Too many signups to group', refused, 'refused');
  if (!loading && timedOut) {
    return notice('This range took too long to compute', 'Pick a shorter range, or try again in a moment.', 'timeout');
  }
  const stale = updating && fetching;
  if (!loading && !error && !stale && data?.status === 'rangeTooLong') {
    return notice(
      `Acquisition covers up to ${data.maxDays} days of signups`,
      'Pick a shorter range to see it.',
      'too-long'
    );
  }

  const ok = data?.status === 'ok' ? data : undefined;
  const caption = ok
    ? `${formatCount(ok.coverage.attributed)} of ${formatCount(ok.coverage.signups)} signups attributed (${formatPercent(ok.coverage.pct)}). Converted counts a first payment within ${ok.conversionWindowDays} days of signup; repeat, renewal and retention look ${ok.followUpDays} days past it.`
    : undefined;

  const table = (
    <Stack gap={1}>
      <DataTable
        rows={ok?.rows ?? []}
        columns={columnsOf(onSelectRow, updating)}
        getRowId={row => row.key}
        rowTestId={row => `acquisition-row-${row.key}`}
        label="Signups by acquisition source"
        onRetry={onRetry}
        pagination={false}
        testId="acquisition-section-table"
      />
      {stale && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="acquisition-section-updating">
          Updating...
        </Typography>
      )}
      {ok?.rows.some(row => row.kind === 'unattributed') && (
        <Typography
          level="body-xs"
          sx={{ color: 'admin.inkMuted' }}
          data-testid="acquisition-section-unattributed-note"
        >
          Unattributed signups carry no campaign touch. Consent is not recorded, so this mixes declined tracking with
          untagged visits.
        </Typography>
      )}
      {ok?.truncated && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="acquisition-section-truncated-note">
          Only the largest campaigns are listed; the rest are summed into Other campaigns.
        </Typography>
      )}
      {ok?.rows.some(row => row.provisional) && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Provisional rows include signups still inside their conversion window, so their rate may rise.
        </Typography>
      )}
    </Stack>
  );

  return (
    <AnalyticsSection
      title={TITLE}
      caption={caption}
      action={controlBar}
      loading={loading || (stale && !ok)}
      error={error}
      onRetry={onRetry}
      empty={!!ok && ok.coverage.signups === 0}
      onShowDefaultRange={onShowDefaultRange}
      chart={table}
      testId="acquisition-section"
    />
  );
}
