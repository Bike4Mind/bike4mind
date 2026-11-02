import React, { useState } from 'react';
import { Alert, Box, Button, FormControl, FormLabel, Radio, RadioGroup, Stack, Tooltip, Typography } from '@mui/joy';
import { Link } from '@tanstack/react-router';
import {
  SHADOW_DETECTION_LIST_LIMIT,
  SHADOW_DETECTION_VERDICTS,
  SHADOW_DETECTORS,
  shadowDetectionPrecision,
  type ShadowDetectionAction,
  type ShadowDetectionNetwork,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
  type ShadowDetector,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterBar,
  StatStrip,
  StatTile,
  StatusChip,
  formatUtc,
  relativeTime,
  useAdminListUrlState,
  type DataColumn,
} from './shared';
import {
  ALL_VERDICTS_FILTER,
  SHADOW_DETECTION_SEARCH_KEYS,
  readShadowDetectionFilters,
  toListQuery,
  type VerdictFilter,
} from './shadowDetectionSearch';
import {
  useShadowDetectionVerdict,
  useShadowDetections,
  type ShadowDetectionRow,
} from '@client/app/hooks/data/shadowDetections';
import { getErrorMessage } from '@client/app/utils/error';

export const DETECTOR_LABELS: Record<ShadowDetector, string> = {
  signupNetworkBurst: 'Signup network burst',
};

const ACTION_DISPLAY: Record<ShadowDetectionAction, { label: string; tone: AdminStatusTone }> = {
  contain: { label: 'Contain', tone: 'neutral' },
  restrict: { label: 'Restrict', tone: 'neutral' },
  suspend: { label: 'Suspend', tone: 'warn' },
  blockIp: { label: 'Block IP', tone: 'warn' },
};

export const VERDICT_DISPLAY: Record<ShadowDetectionVerdict, { label: string; tone: AdminStatusTone }> = {
  confirmed_abuse: { label: 'Confirmed abuse', tone: 'bad' },
  legitimate_human: { label: 'Legitimate human use', tone: 'good' },
  legitimate_automation: { label: 'Legitimate automation', tone: 'good' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'neutral' },
};

const VERDICT_FILTER_LABELS: Record<VerdictFilter, string> = {
  [ALL_VERDICTS_FILTER]: 'All verdicts',
  unreviewed: 'Unreviewed',
  confirmed_abuse: VERDICT_DISPLAY.confirmed_abuse.label,
  legitimate_human: VERDICT_DISPLAY.legitimate_human.label,
  legitimate_automation: VERDICT_DISPLAY.legitimate_automation.label,
  insufficient_evidence: VERDICT_DISPLAY.insufficient_evidence.label,
};

// Users shown per row before collapsing into "+N"; the verdict dialog links every one.
const VISIBLE_USER_IDS = 2;

const muted = { color: 'admin.inkMuted' } as const;

const Dash: React.FC = () => <Typography sx={muted}>-</Typography>;

const Time: React.FC<{ iso: string; now: number }> = ({ iso, now }) => {
  const date = new Date(iso);
  return (
    <Tooltip title={formatUtc(date)}>
      <Typography component="time" dateTime={date.toISOString()} tabIndex={0} level="body-sm" noWrap>
        {relativeTime(date, now)}
      </Typography>
    </Tooltip>
  );
};

export const formatNetwork = (network: ShadowDetectionNetwork): string =>
  [
    network.ip,
    network.asnOrg ?? (network.asn !== null ? `AS${network.asn}` : null),
    network.country,
    network.hosting === null ? null : network.hosting ? 'Hosting' : 'Not hosting',
  ]
    .filter((part): part is string => !!part)
    .join(' / ');

const UserLink: React.FC<{ userId: string; testId: string }> = ({ userId, testId }) => (
  <Link to="/admin/users/$userId" params={{ userId }} data-testid={testId} style={{ textDecoration: 'none' }}>
    <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.link' }}>
      {userId}
    </Typography>
  </Link>
);

const Actor: React.FC<{ row: ShadowDetectionRow }> = ({ row }) => {
  const hidden = row.userIds.slice(VISIBLE_USER_IDS);
  return (
    <Stack gap={0.25} sx={{ minWidth: 0 }}>
      {row.userIds.slice(0, VISIBLE_USER_IDS).map(userId => (
        <UserLink key={userId} userId={userId} testId={`shadow-detection-user-link-${row.id}-${userId}`} />
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.join(', ')}>
          <Typography level="body-xs" tabIndex={0} sx={muted}>
            +{hidden.length.toLocaleString()} more
          </Typography>
        </Tooltip>
      )}
      {row.network && (
        <Typography level="body-xs" noWrap title={formatNetwork(row.network)} sx={muted}>
          {formatNetwork(row.network)}
        </Typography>
      )}
      {row.userIds.length === 0 && !row.network && <Dash />}
    </Stack>
  );
};

const VerdictChip: React.FC<{ verdict: ShadowDetectionVerdict | null; testId?: string }> = ({ verdict, testId }) =>
  verdict ? (
    <StatusChip tone={VERDICT_DISPLAY[verdict].tone} label={VERDICT_DISPLAY[verdict].label} data-testid={testId} />
  ) : (
    <StatusChip tone="neutral" label="Unreviewed" data-testid={testId} />
  );

const SignalValue: React.FC<{ value: number | null }> = ({ value }) =>
  value === null ? (
    <Typography component="span" sx={muted}>
      -
    </Typography>
  ) : (
    <>{value.toLocaleString()}</>
  );

const SignalList: React.FC<{ row: ShadowDetectionRow }> = ({ row }) => (
  <Stack gap={0.5} data-testid="shadow-detection-signals">
    <Typography level="body-xs" sx={muted}>
      Signals{row.windowMinutes !== null ? ` (window: ${row.windowMinutes.toLocaleString()} minutes)` : ''}
    </Typography>
    {row.signals.length === 0 ? (
      <Typography level="body-sm" sx={muted}>
        No signals recorded.
      </Typography>
    ) : (
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {row.signals.map(signal => (
          <Typography key={signal.key} component="li" level="body-sm">
            {signal.label}: <SignalValue value={signal.observed} /> observed, threshold{' '}
            <SignalValue value={signal.threshold} />
          </Typography>
        ))}
      </Box>
    )}
  </Stack>
);

const VerdictHistory: React.FC<{ row: ShadowDetectionRow; now: number }> = ({ row, now }) => {
  const newestFirst = [...row.verdicts].sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
  return (
    <Stack gap={0.5} data-testid="shadow-detection-history">
      <Typography level="body-xs" sx={muted}>
        Verdict history
      </Typography>
      {newestFirst.length === 0 ? (
        <Typography level="body-sm" sx={muted}>
          Not graded yet.
        </Typography>
      ) : (
        newestFirst.map(entry => (
          <Stack
            key={`${entry.reviewedAt}-${entry.reviewerId}`}
            gap={0.25}
            sx={{ py: 0.75, borderTop: '1px solid', borderColor: 'admin.border' }}
          >
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <VerdictChip verdict={entry.verdict} />
              <Time iso={entry.reviewedAt} now={now} />
            </Stack>
            <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
              {entry.reason}
            </Typography>
            <Typography level="body-xs" fontFamily="code" sx={muted}>
              Reviewer {entry.reviewerId}
            </Typography>
          </Stack>
        ))
      )}
    </Stack>
  );
};

/** Precision as a whole percentage, or null when there is no conclusive verdict to divide by. */
export const formatPrecision = (row: ShadowDetectionSummaryRow): { value: string; comparison: string } => {
  const precision = shadowDetectionPrecision(row);
  const conclusive = row.confirmedAbuse + row.legitimateHuman + row.legitimateAutomation;
  if (precision === null) return { value: '-', comparison: 'No conclusive verdicts yet' };
  return { value: `${Math.round(precision * 100)}%`, comparison: `of ${conclusive.toLocaleString()} conclusive` };
};

const SummaryStrip: React.FC<{ row: ShadowDetectionSummaryRow }> = ({ row }) => {
  const graded = row.confirmedAbuse + row.legitimateHuman + row.legitimateAutomation + row.insufficientEvidence;
  const precision = formatPrecision(row);
  const testId = `shadow-detection-summary-${row.detector}-v${row.policyVersion}`;
  return (
    <Stack gap={1} data-testid={testId}>
      <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
        {DETECTOR_LABELS[row.detector]}, policy v{row.policyVersion}
      </Typography>
      <StatStrip aria-label={`${DETECTOR_LABELS[row.detector]} policy v${row.policyVersion}`}>
        <StatTile label="Recorded" value={row.recorded} />
        <StatTile label="Graded" value={graded} comparison={`${(row.recorded - graded).toLocaleString()} unreviewed`} />
        <StatTile
          label="Precision"
          value={
            <Box component="span" data-testid={`${testId}-precision`}>
              {precision.value}
            </Box>
          }
          comparison={precision.comparison}
        />
        <StatTile
          label="False positives"
          value={row.legitimateHuman + row.legitimateAutomation}
          comparison={`${row.legitimateHuman.toLocaleString()} human, ${row.legitimateAutomation.toLocaleString()} automation`}
        />
      </StatStrip>
    </Stack>
  );
};

const CONFLICT_FALLBACK_MESSAGE = 'Another admin graded this detection first. Review it again.';

/** Every account and the network the detection names, so each profile is one click from grading. */
const DialogActors: React.FC<{ row: ShadowDetectionRow }> = ({ row }) => (
  <Stack gap={0.25} data-testid="shadow-detection-dialog-actors" sx={{ minWidth: 0 }}>
    <Typography level="body-xs" sx={muted}>
      {row.userIds.length === 1 ? 'Account' : `Accounts (${row.userIds.length.toLocaleString()})`}
    </Typography>
    {row.userIds.length === 0 ? (
      <Dash />
    ) : (
      row.userIds.map(userId => (
        <UserLink key={userId} userId={userId} testId={`shadow-detection-dialog-user-link-${userId}`} />
      ))
    )}
    {row.network && (
      <Typography level="body-xs" sx={{ ...muted, overflowWrap: 'anywhere' }}>
        {formatNetwork(row.network)}
      </Typography>
    )}
  </Stack>
);

type VerdictDialogProps = {
  row: ShadowDetectionRow;
  now: number;
  onClose: () => void;
  onRowChange: (row: ShadowDetectionRow) => void;
};

const VerdictDialog: React.FC<VerdictDialogProps> = ({ row, now, onClose, onRowChange }) => {
  const mutation = useShadowDetectionVerdict();
  const [verdict, setVerdict] = useState<ShadowDetectionVerdict | null>(null);
  // The server's explanation of a stale verdict, or null when there is no conflict to show.
  const [conflict, setConflict] = useState<string | null>(null);
  const title = row.verdict ? 'Change verdict' : 'Record verdict';

  const submit = async (reason: string) => {
    if (!verdict) return;
    setConflict(null);
    const result = await mutation.mutateAsync({ id: row.id, expectedRevision: row.revision, verdict, reason });
    if (result.status === 'conflict') {
      onRowChange(result.item);
      setConflict(result.message ?? CONFLICT_FALLBACK_MESSAGE);
      return;
    }
    onClose();
  };

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title={title}
      description="Grading measures the detector; it changes nothing on the account. There is no undo: to correct a verdict, record another one. Every verdict stays in the history."
      reasonPresets={ADMIN_REASON_PRESETS.shadowDetectionVerdict}
      confirmLabel={verdict ? `Record ${VERDICT_DISPLAY[verdict].label.toLowerCase()}` : 'Record verdict'}
      blockedReason={verdict ? null : 'Pick a verdict.'}
      pending={mutation.isPending}
      onConfirm={submit}
      data-testid="shadow-detection-verdict-dialog"
    >
      <Stack gap={0.5}>
        <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
          {row.summary}
        </Typography>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography level="body-xs" sx={muted}>
            Current verdict
          </Typography>
          <VerdictChip verdict={row.verdict} testId="shadow-detection-dialog-current-verdict" />
        </Stack>
      </Stack>
      <DialogActors row={row} />
      {conflict && (
        <Alert color="warning" data-testid="shadow-detection-verdict-conflict">
          {conflict} Its current verdict and history are shown below.
        </Alert>
      )}
      {mutation.error && (
        <Alert color="danger" data-testid="shadow-detection-verdict-error">
          {getErrorMessage(mutation.error)}
        </Alert>
      )}
      <FormControl>
        <FormLabel>Verdict</FormLabel>
        <RadioGroup
          name="shadow-detection-verdict"
          value={verdict ?? ''}
          onChange={event => setVerdict(event.target.value as ShadowDetectionVerdict)}
        >
          {SHADOW_DETECTION_VERDICTS.map(option => (
            <Radio
              key={option}
              value={option}
              label={VERDICT_DISPLAY[option].label}
              slotProps={{ input: { 'data-testid': `shadow-detection-verdict-option-${option}` } }}
            />
          ))}
        </RadioGroup>
      </FormControl>
      <SignalList row={row} />
      <VerdictHistory row={row} now={now} />
    </ActionDialog>
  );
};

/**
 * Shadow detections: what an abuse detector would have done to an actor, recorded without acting.
 * Grading each one measures the detector's precision before any automated containment exists.
 */
export const ShadowDetectionsTab: React.FC = () => {
  const [view, updateView] = useAdminListUrlState(SHADOW_DETECTION_SEARCH_KEYS);
  const { detector, verdict } = readShadowDetectionFilters(view.filters);
  const detections = useShadowDetections(toListQuery(detector, verdict));
  const [grading, setGrading] = useState<ShadowDetectionRow | null>(null);
  const [now] = useState(() => Date.now());

  const rows = detections.data?.data ?? [];
  const summary = (detections.data?.summary ?? [])
    .filter(row => !detector || row.detector === detector)
    .sort((a, b) => a.detector.localeCompare(b.detector) || b.policyVersion - a.policyVersion);

  const columns: readonly DataColumn<ShadowDetectionRow>[] = [
    {
      id: 'detectedAt',
      label: 'Detected',
      render: row => <Time iso={row.detectedAt} now={now} />,
      sortValue: row => row.detectedAt,
      width: '8rem',
    },
    {
      id: 'detector',
      label: 'Detector',
      render: row => (
        <Stack sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
            {DETECTOR_LABELS[row.detector]}
          </Typography>
          <Typography level="body-xs" sx={muted}>
            Policy v{row.policyVersion}
          </Typography>
        </Stack>
      ),
      sortValue: row => DETECTOR_LABELS[row.detector],
      width: '11rem',
    },
    {
      id: 'summary',
      label: 'Summary',
      render: row => (
        <Typography level="body-sm" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
          {row.summary}
        </Typography>
      ),
    },
    {
      id: 'wouldAction',
      label: 'Would',
      render: row => (
        <StatusChip
          tone={ACTION_DISPLAY[row.wouldAction].tone}
          label={ACTION_DISPLAY[row.wouldAction].label}
          data-testid={`shadow-detection-action-${row.id}`}
        />
      ),
      sortValue: row => ACTION_DISPLAY[row.wouldAction].label,
      width: '7rem',
    },
    { id: 'actor', label: 'Actor', render: row => <Actor row={row} />, width: '16rem' },
    {
      id: 'verdict',
      label: 'Verdict',
      render: row => <VerdictChip verdict={row.verdict} testId={`shadow-detection-verdict-${row.id}`} />,
      sortValue: row => (row.verdict ? VERDICT_DISPLAY[row.verdict].label : ''),
      width: '11rem',
    },
  ];

  const rowActions = (row: ShadowDetectionRow) => (
    <Button
      size="sm"
      variant="plain"
      color="neutral"
      data-testid={`shadow-detection-grade-btn-${row.id}`}
      onClick={() => setGrading(row)}
    >
      {row.verdict ? 'Change verdict' : 'Record verdict'}
    </Button>
  );

  const filtered = detector !== undefined || verdict !== 'unreviewed';
  const emptyTitle =
    verdict === ALL_VERDICTS_FILTER
      ? 'No detections recorded'
      : verdict === 'unreviewed'
        ? 'No unreviewed detections'
        : `No detections graded ${VERDICT_DISPLAY[verdict].label.toLowerCase()}`;

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md', minWidth: 0 }}
      data-testid="admin-shadow-detections-tab"
    >
      <AdminPageHeader
        title="Detections"
        // A truncated list is not the total: the summary tiles carry the real counts.
        count={detections.data && !detections.data.truncated ? rows.length : undefined}
        description="Detectors record what they would have done to an account or network. Nothing here changes an account: grade each detection so its precision can be measured."
      />
      {summary.length > 0 && (
        <Stack gap={2} data-testid="shadow-detection-summary">
          {summary.map(row => (
            <SummaryStrip key={`${row.detector}-${row.policyVersion}`} row={row} />
          ))}
          <Typography level="body-xs" sx={muted} data-testid="shadow-detection-precision-note">
            Precision is confirmed abuse over conclusive verdicts; insufficient evidence is left out. Recall is not
            measured: accounts the detectors did not flag are not sampled.
          </Typography>
        </Stack>
      )}
      {detections.data?.truncated && (
        <Alert color="warning" data-testid="shadow-detection-truncated">
          Showing the {SHADOW_DETECTION_LIST_LIMIT.toLocaleString()} most recent detections. Narrow the filters to see
          older ones.
        </Alert>
      )}
      <FilterBar
        search={false}
        state={{
          ...view,
          filters: { detector: detector ?? '', verdict: verdict === ALL_VERDICTS_FILTER ? '' : verdict },
        }}
        onChange={patch => {
          if (!patch.filters) return;
          // Clearing the verdict chip means every verdict; an absent value would mean the Unreviewed default.
          updateView({
            filters: { detector: patch.filters.detector ?? '', verdict: patch.filters.verdict || ALL_VERDICTS_FILTER },
            view: '',
          });
        }}
        filters={[
          {
            id: 'detector',
            label: 'Detector',
            options: SHADOW_DETECTORS.map(value => ({ value, label: DETECTOR_LABELS[value] })),
          },
          {
            id: 'verdict',
            label: 'Verdict',
            options: (['unreviewed', ...SHADOW_DETECTION_VERDICTS, ALL_VERDICTS_FILTER] as const).map(value => ({
              value,
              label: VERDICT_FILTER_LABELS[value],
            })),
          },
        ]}
      />
      <DataTable
        rows={rows}
        columns={columns}
        label="Shadow detections"
        getRowId={row => row.id}
        pageResetKey={JSON.stringify([detector, verdict])}
        testId="shadow-detection-table"
        rowTestId={row => `shadow-detection-row-${row.id}`}
        loading={detections.isPending}
        error={detections.error ? "Couldn't load detections." : undefined}
        onRetry={() => void detections.refetch()}
        rowActions={rowActions}
        // The fixed-width columns plus room for the summary; narrower screens scroll sideways.
        minWidth="64rem"
        empty={
          <EmptyState
            title={emptyTitle}
            description={
              verdict === 'unreviewed'
                ? 'Every recorded detection has a verdict. New ones appear here as detectors fire.'
                : undefined
            }
            action={
              <Button
                variant="outlined"
                data-testid="shadow-detection-reset-btn"
                onClick={() => {
                  if (filtered) updateView({ filters: {}, view: '' });
                  else void detections.refetch();
                }}
              >
                {filtered ? 'Clear filters' : 'Refresh'}
              </Button>
            }
          />
        }
      />
      {grading && <VerdictDialog row={grading} now={now} onClose={() => setGrading(null)} onRowChange={setGrading} />}
    </Stack>
  );
};

export default ShadowDetectionsTab;
