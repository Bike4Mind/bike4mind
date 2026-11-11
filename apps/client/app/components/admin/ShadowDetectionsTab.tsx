import React, { useState } from 'react';
import { Alert, Box, Button, FormControl, FormLabel, Radio, RadioGroup, Stack, Tooltip, Typography } from '@mui/joy';
import { Link } from '@tanstack/react-router';
import {
  SHADOW_DETECTION_BULK_VERDICT_LIMIT,
  SHADOW_DETECTION_LIST_LIMIT,
  SHADOW_DETECTION_VERDICTS,
  isAutomationVerdict,
  SELF_ASSESSED_SHADOW_DETECTORS,
  SHADOW_DETECTORS,
  shadowDetectionPrecision,
  type AccountCampaignIgnoredReason,
  type AccountCampaignRelationship,
  type ShadowDetectionAction,
  type ShadowDetectionNetwork,
  type ShadowDetectionPayment,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  AdminPermissionAction,
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterBar,
  StatStrip,
  StatTile,
  StatusChip,
  formatUtc,
  relativeTime,
  useAdminListUrlState,
  type AdminSelection,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import {
  ALL_VERDICTS_FILTER,
  SHADOW_DETECTION_SEARCH_KEYS,
  readShadowDetectionFilters,
  toListQuery,
  type VerdictFilter,
} from './shadowDetectionSearch';
import {
  useShadowDetectionBulkVerdict,
  useShadowDetectionVerdict,
  useShadowDetections,
  type ShadowDetectionBulkVerdictResult,
  type CampaignGroupRow,
  type ShadowDetectionRow,
} from '@client/app/hooks/data/shadowDetections';
import { ShadowDetectionAssessmentPanel } from './ShadowDetectionAssessmentPanel';
import { WatchAccountsButton } from './CampaignWatches/WatchAccountsButton';
import { CampaignWatchesPanel } from './CampaignWatches/CampaignWatchesPanel';
import { VerdictEvalPanel } from './VerdictEvalPanel';
import { DETECTOR_LABELS } from './shadowDetectorLabels';
import { getErrorMessage } from '@client/app/utils/error';

const RELATIONSHIP_LABELS: Record<AccountCampaignRelationship, string> = {
  networkPrefix: 'Network',
  hostingAsn: 'Hosting network',
  mailDomain: 'Mail domain',
  fingerprint: 'Client fingerprint',
  lifecycle: 'Lifecycle timing',
};

const IGNORED_REASON_LABELS: Record<AccountCampaignIgnoredReason, string> = {
  common: 'common',
  personalMailProvider: 'personal mail provider',
};

const ACTION_DISPLAY: Record<ShadowDetectionAction, { label: string; tone: AdminStatusTone }> = {
  contain: { label: 'Contain', tone: 'neutral' },
  restrict: { label: 'Restrict', tone: 'neutral' },
  suspend: { label: 'Suspend', tone: 'warn' },
  blockIp: { label: 'Block IP', tone: 'warn' },
  confirmHold: { label: 'Confirm hold', tone: 'neutral' },
  none: { label: 'None', tone: 'neutral' },
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
  automated: 'Graded by automation',
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

/** The payment in the Stripe Dashboard it was taken in; test-mode payments live under /test. */
export const stripePaymentUrl = (payment: Pick<ShadowDetectionPayment, 'paymentIntentId' | 'livemode'>): string =>
  `https://dashboard.stripe.com${payment.livemode ? '' : '/test'}/payments/${encodeURIComponent(payment.paymentIntentId)}`;

const currencyDecimals = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

export const formatPaymentAmount = (payment: Pick<ShadowDetectionPayment, 'amount' | 'currency'>): string => {
  if (payment.amount === null || !payment.currency) return 'Unknown amount';
  const decimals = currencyDecimals(payment.currency);
  return `${(payment.amount / 10 ** decimals).toFixed(decimals)} ${payment.currency.toUpperCase()}`;
};

const StripePaymentLink: React.FC<{ payment: ShadowDetectionPayment; testId: string }> = ({ payment, testId }) => (
  <Typography
    component="a"
    href={stripePaymentUrl(payment)}
    target="_blank"
    rel="noopener noreferrer"
    level="body-xs"
    fontFamily="code"
    data-testid={testId}
    sx={{ color: 'admin.link', textDecoration: 'none', overflowWrap: 'anywhere' }}
  >
    {payment.paymentIntentId}
  </Typography>
);

const PaymentEvidence: React.FC<{ payment: ShadowDetectionPayment }> = ({ payment }) => (
  <Stack gap={0.25} data-testid="shadow-detection-dialog-payment" sx={{ minWidth: 0 }}>
    <Typography level="body-xs" sx={muted}>
      Payment
    </Typography>
    <Typography level="body-sm">
      {`${payment.kind} payment ${payment.outcome}, ${formatPaymentAmount(payment)}`}
      {payment.riskLevel ? `, Radar risk ${payment.riskLevel}` : ''}
    </Typography>
    <StripePaymentLink payment={payment} testId="shadow-detection-dialog-stripe-link" />
    {!payment.livemode && (
      <Typography level="body-xs" sx={muted}>
        Stripe test mode
      </Typography>
    )}
  </Stack>
);

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
      {row.payment && <StripePaymentLink payment={row.payment} testId={`shadow-detection-stripe-link-${row.id}`} />}
      {row.userIds.length === 0 && !row.network && !row.payment && <Dash />}
    </Stack>
  );
};

/** An automation verdict reads as such, so it is never mistaken for an admin's judgment. */
const VerdictChip: React.FC<{ verdict: ShadowDetectionVerdict | null; automated?: boolean; testId?: string }> = ({
  verdict,
  automated = false,
  testId,
}) =>
  verdict ? (
    <StatusChip
      tone={VERDICT_DISPLAY[verdict].tone}
      label={automated ? `${VERDICT_DISPLAY[verdict].label} (automation)` : VERDICT_DISPLAY[verdict].label}
      data-testid={testId}
    />
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
              <VerdictChip verdict={entry.verdict} automated={entry.source === 'automation'} />
              <Time iso={entry.reviewedAt} now={now} />
            </Stack>
            <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
              {entry.reason}
            </Typography>
            {entry.source === 'automation' ? (
              <Typography level="body-xs" sx={muted}>
                Graded by automation
              </Typography>
            ) : (
              <Typography level="body-xs" fontFamily="code" sx={muted}>
                Reviewer {entry.reviewerId}
              </Typography>
            )}
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

/**
 * Graded and precision count only admin verdicts on records that would have acted; `noAction` rows are
 * listed only, and automation verdicts are counted apart.
 */
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
        <StatTile
          label="Recorded"
          value={row.recorded}
          comparison={row.noAction > 0 ? `${row.noAction.toLocaleString()} would not act` : undefined}
        />
        <StatTile
          label="Graded"
          value={graded}
          comparison={`${(row.recorded - row.noAction - graded - row.automated).toLocaleString()} unreviewed`}
        />
        <StatTile
          label="Automation"
          value={
            <Box component="span" data-testid={`${testId}-automated`}>
              {row.automated.toLocaleString()}
            </Box>
          }
          comparison="stale, insufficient evidence"
        />
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

const countOf = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

/**
 * A campaign group's accounts with how each is linked, then the shared values that linked them and the
 * ones discounted as common. Transitive members are context, linked to the group through one member.
 */
const CampaignGroupEvidence: React.FC<{ group: CampaignGroupRow; now: number }> = ({ group, now }) => (
  <Stack gap={1} data-testid="shadow-detection-campaign-group" sx={{ minWidth: 0 }}>
    <Typography level="body-xs" sx={muted}>
      Accounts ({group.totals.direct.toLocaleString()} direct, {group.totals.transitive.toLocaleString()} transitive,{' '}
      {group.totals.links.toLocaleString()} links). Last seen {relativeTime(new Date(group.lastObservedAt), now)}, first
      seen {formatUtc(new Date(group.firstObservedAt))}. Populations count the accounts scanned from{' '}
      {formatUtc(new Date(group.window.from))} to {formatUtc(new Date(group.window.to))}.
    </Typography>
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {group.members.map(member => (
        <Box component="li" key={member.userId} data-testid={`shadow-detection-campaign-member-${member.userId}`}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <UserLink userId={member.userId} testId={`shadow-detection-dialog-user-link-${member.userId}`} />
            <Box component="span" data-testid={`shadow-detection-campaign-membership-${member.userId}`}>
              <StatusChip
                tone={member.membership === 'direct' ? 'warn' : 'neutral'}
                label={member.membership === 'direct' ? 'Direct' : 'Transitive'}
              />
            </Box>
            <Typography level="body-xs" sx={muted}>
              {member.linkCount.toLocaleString()} {member.linkCount === 1 ? 'link' : 'links'}
            </Typography>
          </Stack>
        </Box>
      ))}
    </Box>
    {group.truncated && (
      <Typography level="body-xs" sx={muted} data-testid="shadow-detection-campaign-truncated">
        Lists were cut to their stored caps; the counts above are complete.
      </Typography>
    )}
    <Typography level="body-xs" sx={muted}>
      Linked by
    </Typography>
    <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="shadow-detection-campaign-evidence">
      {group.evidence.map(entry => (
        <Typography
          key={`${entry.relationship}:${entry.value ?? ''}`}
          component="li"
          level="body-sm"
          sx={{ overflowWrap: 'anywhere' }}
        >
          {entry.label} ({countOf(entry.userIds.length, 'member')}; shared by{' '}
          {countOf(entry.population, 'scanned account')})
        </Typography>
      ))}
    </Box>
    {group.ignored.length > 0 && (
      <>
        <Typography level="body-xs" sx={muted}>
          Shared but not counted
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="shadow-detection-campaign-ignored">
          {group.ignored.map(entry => (
            <Typography
              key={`${entry.relationship}:${entry.value}`}
              component="li"
              level="body-sm"
              sx={{ ...muted, overflowWrap: 'anywhere' }}
            >
              {RELATIONSHIP_LABELS[entry.relationship]} {entry.value}: {IGNORED_REASON_LABELS[entry.reason]} (
              {countOf(entry.memberCount, 'member')}; shared by {countOf(entry.population, 'scanned account')})
            </Typography>
          ))}
        </Box>
      </>
    )}
    {(group.unknown.fingerprint > 0 || group.unknown.network > 0) && (
      <Typography level="body-xs" sx={muted} data-testid="shadow-detection-campaign-unknown">
        Not captured, so neither for nor against a link:{' '}
        {[
          group.unknown.fingerprint > 0 && `client fingerprint for ${countOf(group.unknown.fingerprint, 'member')}`,
          group.unknown.network > 0 && `network for ${countOf(group.unknown.network, 'member')}`,
        ]
          .filter(Boolean)
          .join(', ')}
        .
      </Typography>
    )}
  </Stack>
);

/** Every account and the network the detection names, so each profile is one click from grading. */
const DialogActors: React.FC<{ row: ShadowDetectionRow; now: number }> = ({ row, now }) =>
  row.group ? (
    <CampaignGroupEvidence group={row.group} now={now} />
  ) : (
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
      {row.payment && <PaymentEvidence payment={row.payment} />}
    </Stack>
  );

type VerdictDialogProps = {
  row: ShadowDetectionRow;
  now: number;
  onClose: () => void;
  onRowChange: (row: ShadowDetectionRow) => void;
};

const CAPPED_GROUP_HINT = 'This group was cut to its stored cap, so it cannot be saved as a watch.';

const VerdictDialog: React.FC<VerdictDialogProps> = ({ row, now, onClose, onRowChange }) => {
  const mutation = useShadowDetectionVerdict();
  const [verdict, setVerdict] = useState<ShadowDetectionVerdict | null>(null);
  // The server's explanation of a stale verdict, or null when there is no conflict to show.
  const [conflict, setConflict] = useState<string | null>(null);
  const title = row.verdict ? 'View review' : 'Review evidence';

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
      <DialogActors row={row} now={now} />
      {row.detector === 'accountCampaign' && (
        <WatchAccountsButton
          userIds={row.userIds}
          sourceDetectionId={row.id}
          label="Watch campaign"
          incomplete={row.group?.truncated}
          incompleteHint={CAPPED_GROUP_HINT}
          onCreated={onClose}
        />
      )}
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
      {!SELF_ASSESSED_SHADOW_DETECTORS.includes(row.detector) && (
        <ShadowDetectionAssessmentPanel detectionId={row.id} enabled />
      )}
      <VerdictHistory row={row} now={now} />
    </ActionDialog>
  );
};

const EMPTY_SELECTION: AdminSelection = { mode: 'explicit', ids: [] };

const bulkOutcomeMessage = (result: ShadowDetectionBulkVerdictResult): string => {
  const parts = [`Graded ${countOf(result.graded.length, 'detection')}.`];
  if (result.conflicts.length > 0) {
    parts.push(
      `${countOf(result.conflicts.length, 'detection')} changed since you selected them and were left as they are.`
    );
  }
  if (result.missing.length > 0) parts.push(`${countOf(result.missing.length, 'detection')} no longer exist.`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} could not be graded; try them again.`);
  return parts.join(' ');
};

type BulkVerdictDialogProps = {
  rows: ShadowDetectionRow[];
  onClose: () => void;
  onDone: (result: ShadowDetectionBulkVerdictResult) => void;
};

/** One verdict and reason for every selected detection; each still gets its own history entry. */
const BulkVerdictDialog: React.FC<BulkVerdictDialogProps> = ({ rows, onClose, onDone }) => {
  const mutation = useShadowDetectionBulkVerdict();
  const [verdict, setVerdict] = useState<ShadowDetectionVerdict | null>(null);
  const overCap = rows.length > SHADOW_DETECTION_BULK_VERDICT_LIMIT;

  const submit = async (reason: string) => {
    if (!verdict || overCap) return;
    const result = await mutation.mutateAsync({
      items: rows.map(row => ({ id: row.id, expectedRevision: row.revision })),
      verdict,
      reason,
    });
    onDone(result);
  };

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title={`Record a verdict for ${countOf(rows.length, 'detection')}`}
      description="Every selected detection gets this verdict and reason as its own history entry. Grading measures the detectors; it changes nothing on any account. A detection someone else graded since you selected it is left as it is."
      reasonPresets={ADMIN_REASON_PRESETS.shadowDetectionVerdict}
      confirmLabel={verdict ? `Record ${VERDICT_DISPLAY[verdict].label.toLowerCase()}` : 'Record verdict'}
      blockedReason={
        overCap
          ? `Grade at most ${SHADOW_DETECTION_BULK_VERDICT_LIMIT.toLocaleString()} detections at once. Narrow the filter or select fewer rows.`
          : verdict
            ? null
            : 'Pick a verdict.'
      }
      pending={mutation.isPending}
      onConfirm={submit}
      data-testid="shadow-detection-bulk-verdict-dialog"
    >
      {mutation.error && (
        <Alert color="danger" data-testid="shadow-detection-bulk-verdict-error">
          {getErrorMessage(mutation.error)}
        </Alert>
      )}
      <FormControl>
        <FormLabel>Verdict</FormLabel>
        <RadioGroup
          name="shadow-detection-bulk-verdict"
          value={verdict ?? ''}
          onChange={event => setVerdict(event.target.value as ShadowDetectionVerdict)}
        >
          {SHADOW_DETECTION_VERDICTS.map(option => (
            <Radio
              key={option}
              value={option}
              label={VERDICT_DISPLAY[option].label}
              slotProps={{ input: { 'data-testid': `shadow-detection-bulk-verdict-option-${option}` } }}
            />
          ))}
        </RadioGroup>
      </FormControl>
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
  const [selection, setSelection] = useState<AdminSelection>(EMPTY_SELECTION);
  const [bulkGrading, setBulkGrading] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<ShadowDetectionBulkVerdictResult | null>(null);
  const [now] = useState(() => Date.now());

  const rows = detections.data?.data ?? [];
  // "All matching" is every loaded row of the current filter; the server caps one request.
  const selectedRows = selection.mode === 'allMatching' ? rows : rows.filter(row => selection.ids.includes(row.id));
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
      label: 'Suggested response',
      render: row => (
        <StatusChip
          tone={ACTION_DISPLAY[row.wouldAction].tone}
          label={ACTION_DISPLAY[row.wouldAction].label}
          data-testid={`shadow-detection-action-${row.id}`}
        />
      ),
      sortValue: row => ACTION_DISPLAY[row.wouldAction].label,
      width: '11.5rem',
    },
    { id: 'actor', label: 'Actor', render: row => <Actor row={row} />, width: '16rem' },
    {
      id: 'verdict',
      label: 'Verdict',
      render: row => (
        <VerdictChip
          verdict={row.verdict}
          automated={isAutomationVerdict(row)}
          testId={`shadow-detection-verdict-${row.id}`}
        />
      ),
      sortValue: row => (row.verdict ? VERDICT_DISPLAY[row.verdict].label : ''),
      width: '11rem',
    },
  ];

  const rowActions = (row: ShadowDetectionRow) => (
    <Stack gap={0.5} alignItems="flex-start">
      <AdminPermissionAction requirement="users:moderate">
        {disabled => (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled={disabled}
            data-testid={`shadow-detection-grade-btn-${row.id}`}
            onClick={() => setGrading(row)}
          >
            {row.verdict ? 'View review' : 'Review evidence'}
          </Button>
        )}
      </AdminPermissionAction>
      {row.detector === 'accountCampaign' && (
        <WatchAccountsButton
          userIds={row.userIds}
          sourceDetectionId={row.id}
          label="Watch"
          incomplete={row.group?.truncated}
          incompleteHint={CAPPED_GROUP_HINT}
        />
      )}
    </Stack>
  );

  const filtered = detector !== undefined || verdict !== 'unreviewed';
  const emptyTitle =
    verdict === ALL_VERDICTS_FILTER
      ? 'No detections recorded'
      : verdict === 'unreviewed'
        ? 'No unreviewed detections'
        : verdict === 'automated'
          ? 'No detections graded by automation'
          : `No detections graded ${VERDICT_DISPLAY[verdict].label.toLowerCase()}`;

  return (
    <Stack
      spacing={ADMIN_REGION_GAP}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', borderRadius: 'md', minWidth: 0 }}
      data-testid="admin-shadow-detections-tab"
    >
      <AdminPageHeader
        title="Detections"
        // A truncated list is not the total: the summary tiles carry the real counts.
        count={detections.data && !detections.data.truncated ? rows.length : undefined}
        description="Review flagged activity, inspect the evidence, and keep account groups under watch while you investigate. Detector suggestions and recorded judgments do not change account access."
      />
      <Alert color="neutral" data-testid="detections-start-here">
        <Stack gap={0.5}>
          <Typography level="title-sm">Start here</Typography>
          <Typography level="body-sm">
            1. Open Review evidence, then inspect the linked accounts and their activity.
          </Typography>
          <Typography level="body-sm">
            2. If you need more time, watch the campaign. Its fixed account list stays available after the advisory
            expires.
          </Typography>
          <Typography level="body-sm">
            3. Record a judgment when the evidence supports one. Recording a judgment does not change account access;
            suggested responses are not actions applied by this table.
          </Typography>
        </Stack>
      </Alert>
      {summary.length > 0 && (
        <Stack gap={2} data-testid="shadow-detection-summary">
          {summary.map(row => (
            <SummaryStrip key={`${row.detector}-${row.policyVersion}`} row={row} />
          ))}
          <Typography level="body-xs" sx={muted} data-testid="shadow-detection-precision-note">
            Precision is confirmed abuse over conclusive verdicts; insufficient evidence is left out. Automation
            verdicts (stale signup bursts that nothing corroborated) are counted apart from admin verdicts. Recall is
            not measured: accounts the detectors did not flag are not sampled.
          </Typography>
        </Stack>
      )}
      <VerdictEvalPanel />
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
          setSelection(EMPTY_SELECTION);
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
            options: (['unreviewed', ...SHADOW_DETECTION_VERDICTS, 'automated', ALL_VERDICTS_FILTER] as const).map(
              value => ({
                value,
                label: VERDICT_FILTER_LABELS[value],
              })
            ),
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
        selection={selection}
        onSelectionChange={setSelection}
        // Fixed-width columns (incl. the 2.75rem selection and 3.5rem row-action columns) total 63.75rem,
        // leaving Summary a 12rem floor; keep in sync with the column widths above and in DataTable.
        // Narrower screens scroll sideways.
        minWidth="75.75rem"
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
      {bulkOutcome && (
        <Alert
          color={
            bulkOutcome.conflicts.length + bulkOutcome.missing.length + bulkOutcome.failed.length > 0
              ? 'warning'
              : 'success'
          }
          data-testid="shadow-detection-bulk-outcome"
          endDecorator={
            <Button size="sm" variant="plain" color="neutral" onClick={() => setBulkOutcome(null)}>
              Dismiss
            </Button>
          }
        >
          {bulkOutcomeMessage(bulkOutcome)}
        </Alert>
      )}
      <BulkActionBar
        selection={selection}
        totalMatching={rows.length}
        selectAllLabel={detections.data?.truncated ? `Select all ${rows.length.toLocaleString()} loaded` : undefined}
        onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
        onClear={() => setSelection(EMPTY_SELECTION)}
      >
        <AdminPermissionAction requirement="users:moderate">
          {disabled => (
            <Button
              size="sm"
              disabled={disabled || selectedRows.length === 0}
              data-testid="shadow-detection-bulk-grade-btn"
              onClick={() => setBulkGrading(true)}
            >
              Record verdict
            </Button>
          )}
        </AdminPermissionAction>
      </BulkActionBar>
      {bulkGrading && (
        <BulkVerdictDialog
          rows={selectedRows}
          onClose={() => setBulkGrading(false)}
          onDone={result => {
            setBulkGrading(false);
            setSelection(EMPTY_SELECTION);
            setBulkOutcome(result);
          }}
        />
      )}
      <CampaignWatchesPanel />
      {grading && <VerdictDialog row={grading} now={now} onClose={() => setGrading(null)} onRowChange={setGrading} />}
    </Stack>
  );
};

export default ShadowDetectionsTab;
