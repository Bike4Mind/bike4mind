import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  IconButton,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import { Link } from '@tanstack/react-router';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import {
  SHADOW_DETECTION_LIST_LIMIT,
  SHADOW_DETECTION_VERDICTS,
  SELF_ASSESSED_SHADOW_DETECTORS,
  SHADOW_DETECTORS,
  shadowDetectionPrecision,
  shadowDetectionSignalTrip,
  type AccountCampaignIgnoredReason,
  type AccountCampaignRelationship,
  type ShadowDetectionAccount,
  type ShadowDetectionAccountStatus,
  type ShadowDetectionAction,
  type ShadowDetectionBurstPeers,
  type ShadowDetectionNetwork,
  type ShadowDetectionPayment,
  type ShadowDetectionSignal,
  type ShadowDetectionSignalRule,
  type ShadowDetectionSummaryRow,
  type ShadowDetectionVerdict,
  type ShadowDetectionVerdictSource,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterBar,
  Kbd,
  StatStrip,
  StatTile,
  StatusChip,
  formatUtc,
  relativeTime,
  useAdminListUrlState,
  type AdminSelection,
  type DataColumn,
  type DataTableGroup,
} from './shared';
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
  type CampaignGroupRow,
  type ShadowDetectionBulkVerdictResult,
  type ShadowDetectionRow,
} from '@client/app/hooks/data/shadowDetections';
import { ShadowDetectionAssessmentPanel } from './ShadowDetectionAssessmentPanel';
import { DetectionsIntro, EnforceBarTile, TermHelp, VERDICT_GUIDES } from './shadowDetectionExplainer';
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
  confirmed_abuse: VERDICT_DISPLAY.confirmed_abuse.label,
  legitimate_human: VERDICT_DISPLAY.legitimate_human.label,
  legitimate_automation: VERDICT_DISPLAY.legitimate_automation.label,
  insufficient_evidence: VERDICT_DISPLAY.insufficient_evidence.label,
};

const ACCOUNT_STATUS_DISPLAY: Record<ShadowDetectionAccountStatus, { label: string; tone: AdminStatusTone }> = {
  active: { label: 'Active', tone: 'good' },
  suspended: { label: 'Suspended', tone: 'bad' },
  deleted: { label: 'Deleted', tone: 'neutral' },
  missing: { label: 'Not found', tone: 'neutral' },
};

const VERDICT_SOURCE_ACTIONS: Record<Exclude<ShadowDetectionVerdictSource, 'review'>, string> = {
  suspension: 'suspended',
  reinstatement: 'reinstated',
};

type VerdictEntry = ShadowDetectionRow['verdicts'][number];
type ReviewerNames = ReadonlyMap<string, string | null>;

const latestVerdictEntry = (row: ShadowDetectionRow): VerdictEntry | null =>
  row.verdicts.reduce<VerdictEntry | null>(
    (latest, entry) => (!latest || entry.reviewedAt > latest.reviewedAt ? entry : latest),
    null
  );

const reviewerLabel = (reviewers: ReviewerNames, reviewerId: string) =>
  reviewers.get(reviewerId) ?? `reviewer ${reviewerId}`;

const isAutomatic = (entry: VerdictEntry) => entry.source === 'suspension' || entry.source === 'reinstatement';

/** Who set a verdict: the reviewer, or the admin action that graded it automatically. */
const verdictAttribution = (entry: VerdictEntry, reviewers: ReviewerNames): string => {
  const name = reviewerLabel(reviewers, entry.reviewerId);
  if (entry.source === 'suspension' || entry.source === 'reinstatement') {
    return `Automatic: account ${VERDICT_SOURCE_ACTIONS[entry.source]} by ${name}`;
  }
  return `By ${name}`;
};

// Users shown per row before collapsing into "+N"; the verdict dialog links every one.
const VISIBLE_USER_IDS = 2;

/**
 * What the list response says beside the detections: each named account as it is now, the burst peers
 * of signupNetworkBurst rows, and for each row the other unreviewed listed detections naming one of its
 * accounts (so one verdict can settle them together), and the display name of each verdict's reviewer.
 */
export type DetectionContext = {
  accounts: ReadonlyMap<string, ShadowDetectionAccount>;
  burstPeers: ReadonlyMap<string, ShadowDetectionBurstPeers>;
  related: ReadonlyMap<string, readonly ShadowDetectionRow[]>;
  reviewers: ReviewerNames;
};

const EMPTY_RELATED: readonly ShadowDetectionRow[] = [];

/** Other unreviewed rows that name one of each row's accounts, in list order. */
export const relatedUnreviewed = (rows: readonly ShadowDetectionRow[]): Map<string, ShadowDetectionRow[]> => {
  const byUser = new Map<string, ShadowDetectionRow[]>();
  for (const row of rows) {
    if (row.verdict) continue;
    for (const userId of row.userIds) byUser.set(userId, [...(byUser.get(userId) ?? []), row]);
  }
  const related = new Map<string, ShadowDetectionRow[]>();
  for (const row of rows) {
    const others = new Map<string, ShadowDetectionRow>();
    for (const userId of row.userIds) {
      for (const other of byUser.get(userId) ?? []) if (other.id !== row.id) others.set(other.id, other);
    }
    if (others.size > 0) related.set(row.id, [...others.values()]);
  }
  return related;
};

/**
 * Accounts named by two or more listed detections, each with its detections, in list order. A row
 * joins the first such account it names, so every row is in at most one group.
 */
export const groupByAccount = (
  rows: readonly ShadowDetectionRow[]
): { userId: string; rows: ShadowDetectionRow[] }[] => {
  const counts = new Map<string, number>();
  for (const row of rows) for (const userId of new Set(row.userIds)) counts.set(userId, (counts.get(userId) ?? 0) + 1);
  const groups = new Map<string, ShadowDetectionRow[]>();
  for (const row of rows) {
    const userId = row.userIds.find(id => (counts.get(id) ?? 0) > 1);
    if (userId) groups.set(userId, [...(groups.get(userId) ?? []), row]);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([userId, members]) => ({ userId, rows: members }));
};

export const formatAccountFacts = (account: ShadowDetectionAccount): string =>
  [account.signupMethod, account.currentCredits === null ? null : `${account.currentCredits.toLocaleString()} credits`]
    .filter((part): part is string => !!part)
    .join(' / ');

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

/** An account link with its status, signup method and balance as they are now. */
const AccountLine: React.FC<{
  userId: string;
  account: ShadowDetectionAccount | undefined;
  linkTestId: string;
  testId: string;
}> = ({ userId, account, linkTestId, testId }) => (
  <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap" sx={{ minWidth: 0 }} data-testid={testId}>
    <UserLink userId={userId} testId={linkTestId} />
    {account && (
      <StatusChip
        tone={ACCOUNT_STATUS_DISPLAY[account.status].tone}
        label={ACCOUNT_STATUS_DISPLAY[account.status].label}
        data-testid={`${testId}-status`}
      />
    )}
    {account && formatAccountFacts(account) && (
      <Typography level="body-xs" noWrap sx={muted} data-testid={`${testId}-facts`}>
        {formatAccountFacts(account)}
      </Typography>
    )}
  </Stack>
);

const peerCount = (peers: ShadowDetectionBurstPeers) =>
  `${peers.userIds.length.toLocaleString()}${peers.truncated ? '+' : ''}`;

/** The burst's other signups, collapsed after VISIBLE_USER_IDS; the dialog lists them all. */
const BurstPeersSummary: React.FC<{ rowId: string; peers: ShadowDetectionBurstPeers }> = ({ rowId, peers }) => {
  const hidden = peers.userIds.slice(VISIBLE_USER_IDS);
  return (
    <Stack gap={0.25} sx={{ minWidth: 0 }} data-testid={`shadow-detection-burst-peers-${rowId}`}>
      <Typography level="body-xs" sx={muted}>
        Same IP, same window: {peerCount(peers)} other{' '}
        {peers.userIds.length === 1 && !peers.truncated ? 'account' : 'accounts'}
      </Typography>
      {peers.userIds.slice(0, VISIBLE_USER_IDS).map(userId => (
        <UserLink key={userId} userId={userId} testId={`shadow-detection-burst-peer-link-${rowId}-${userId}`} />
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.join(', ')}>
          <Typography level="body-xs" tabIndex={0} sx={muted}>
            +{hidden.length.toLocaleString()} more
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
};

const Actor: React.FC<{ row: ShadowDetectionRow; context: DetectionContext }> = ({ row, context }) => {
  const hidden = row.userIds.slice(VISIBLE_USER_IDS);
  const related = context.related.get(row.id) ?? EMPTY_RELATED;
  const peers = context.burstPeers.get(row.id);
  return (
    <Stack gap={0.25} sx={{ minWidth: 0 }}>
      {row.userIds.slice(0, VISIBLE_USER_IDS).map(userId => (
        <AccountLine
          key={userId}
          userId={userId}
          account={context.accounts.get(userId)}
          linkTestId={`shadow-detection-user-link-${row.id}-${userId}`}
          testId={`shadow-detection-account-${row.id}-${userId}`}
        />
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.join(', ')}>
          <Typography level="body-xs" tabIndex={0} sx={muted}>
            +{hidden.length.toLocaleString()} more
          </Typography>
        </Tooltip>
      )}
      {related.length > 0 && (
        <Box>
          <StatusChip
            tone="warn"
            label={`${(related.length + 1).toLocaleString()} open detections`}
            data-testid={`shadow-detection-related-${row.id}`}
          />
        </Box>
      )}
      {peers && peers.userIds.length > 0 && <BurstPeersSummary rowId={row.id} peers={peers} />}
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

const RULE_TEXT: Record<ShadowDetectionSignalRule, (threshold: string) => string> = {
  above: threshold => `more than ${threshold}`,
  atLeast: threshold => `${threshold} or more`,
  below: threshold => `under ${threshold}`,
  atMost: threshold => `${threshold} or less`,
};

/**
 * Why the detector fired: the signals that crossed their rule (SHADOW_DETECTION_SIGNAL_RULES in common),
 * then every other signal as context. A detection with no known tripped rule falls back to its summary.
 */
const SignalList: React.FC<{ row: ShadowDetectionRow }> = ({ row }) => {
  const tripped: { signal: ShadowDetectionSignal; rule: ShadowDetectionSignalRule }[] = [];
  const context: ShadowDetectionSignal[] = [];
  for (const signal of row.signals) {
    const rule = shadowDetectionSignalTrip(signal);
    if (rule) tripped.push({ signal, rule });
    else context.push(signal);
  }
  const withinWindow = row.windowMinutes !== null ? ` within ${row.windowMinutes.toLocaleString()} minutes` : '';
  return (
    <Stack gap={1} data-testid="shadow-detection-signals">
      <Stack gap={0.5} data-testid="shadow-detection-trigger">
        <Typography level="body-xs" sx={muted}>
          Why it was flagged
        </Typography>
        {tripped.length === 0 ? (
          <Typography level="body-sm">Flagged: {row.summary}</Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {tripped.map(({ signal, rule }) => (
              <Typography
                key={signal.key}
                component="li"
                level="body-sm"
                data-testid={`shadow-detection-trigger-${signal.key}`}
              >
                {signal.label}: <strong>{signal.observed?.toLocaleString()}</strong>
                {withinWindow} (rule: {RULE_TEXT[rule](signal.threshold?.toLocaleString() ?? '')})
              </Typography>
            ))}
          </Box>
        )}
      </Stack>
      {context.length > 0 && (
        <Stack gap={0.5} data-testid="shadow-detection-signal-context">
          <Typography level="body-xs" sx={muted}>
            Context
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {context.map(signal => (
              <Typography key={signal.key} component="li" level="body-sm">
                {signal.label}: <SignalValue value={signal.observed} />
                {signal.threshold !== null && (
                  <Typography component="span" sx={muted}>
                    {' '}
                    (threshold {signal.threshold.toLocaleString()})
                  </Typography>
                )}
              </Typography>
            ))}
          </Box>
        </Stack>
      )}
    </Stack>
  );
};

/** The current verdict's author and reason, under the dialog's current-verdict chip. */
const CurrentVerdictAttribution: React.FC<{ row: ShadowDetectionRow; reviewers: ReviewerNames }> = ({
  row,
  reviewers,
}) => {
  const entry = latestVerdictEntry(row);
  if (!row.verdict || !entry) return null;
  return (
    <Stack gap={0.25} data-testid="shadow-detection-dialog-verdict-attribution">
      <Typography level="body-xs" sx={muted}>
        {verdictAttribution(entry, reviewers)} on {formatUtc(new Date(entry.reviewedAt))}
      </Typography>
      <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
        {entry.reason}
      </Typography>
    </Stack>
  );
};

/** "Automatic" or "By <reviewer>" under a row's verdict chip. */
const RowVerdictAttribution: React.FC<{ row: ShadowDetectionRow; reviewers: ReviewerNames }> = ({ row, reviewers }) => {
  const entry = latestVerdictEntry(row);
  if (!row.verdict || !entry) return null;
  const label = isAutomatic(entry) ? 'Automatic' : `By ${reviewerLabel(reviewers, entry.reviewerId)}`;
  return (
    <Tooltip title={`${verdictAttribution(entry, reviewers)}: ${entry.reason}`}>
      <Typography
        level="body-xs"
        noWrap
        tabIndex={0}
        sx={{ ...muted, maxWidth: '100%' }}
        data-testid={`shadow-detection-verdict-by-${row.id}`}
      >
        {label}
      </Typography>
    </Tooltip>
  );
};

const VerdictHistory: React.FC<{ row: ShadowDetectionRow; now: number; reviewers: ReviewerNames }> = ({
  row,
  now,
  reviewers,
}) => {
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
            <Typography level="body-xs" sx={muted} data-testid="shadow-detection-history-source">
              {verdictAttribution(entry, reviewers)}
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

/** Graded and precision count only records that would have acted; `noAction` rows are listed only. */
const SummaryStrip: React.FC<{ row: ShadowDetectionSummaryRow }> = ({ row }) => {
  const graded = row.confirmedAbuse + row.legitimateHuman + row.legitimateAutomation + row.insufficientEvidence;
  const precision = formatPrecision(row);
  const testId = `shadow-detection-summary-${row.detector}-v${row.policyVersion}`;
  return (
    <Stack gap={1} data-testid={testId}>
      <Stack direction="row" alignItems="center" gap={0.25}>
        <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
          {DETECTOR_LABELS[row.detector]}, policy v{row.policyVersion}
        </Typography>
        <Box sx={{ display: 'flex', my: -1, '& svg': { fontSize: 16 } }}>
          <TermHelp term="policy" />
        </Box>
      </Stack>
      <StatStrip aria-label={`${DETECTOR_LABELS[row.detector]} policy v${row.policyVersion}`}>
        <StatTile
          label="Recorded"
          help={<TermHelp term="recorded" />}
          value={row.recorded}
          comparison={row.noAction > 0 ? `${row.noAction.toLocaleString()} would not act` : undefined}
        />
        <StatTile
          label="Graded"
          help={<TermHelp term="graded" />}
          value={graded}
          comparison={`${(row.recorded - row.noAction - graded).toLocaleString()} unreviewed`}
        />
        <StatTile
          label="Precision"
          help={<TermHelp term="precision" />}
          value={
            <Box component="span" data-testid={`${testId}-precision`}>
              {precision.value}
            </Box>
          }
          comparison={precision.comparison}
        />
        <StatTile
          label="False positives"
          help={<TermHelp term="falsePositives" />}
          value={row.legitimateHuman + row.legitimateAutomation}
          comparison={`${row.legitimateHuman.toLocaleString()} human, ${row.legitimateAutomation.toLocaleString()} automation`}
        />
        <EnforceBarTile row={row} testId={testId} />
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
const CampaignGroupEvidence: React.FC<{
  group: CampaignGroupRow;
  now: number;
  accounts: DetectionContext['accounts'];
}> = ({ group, now, accounts }) => (
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
            <AccountLine
              userId={member.userId}
              account={accounts.get(member.userId)}
              linkTestId={`shadow-detection-dialog-user-link-${member.userId}`}
              testId={`shadow-detection-dialog-account-${member.userId}`}
            />
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
const DialogActors: React.FC<{ row: ShadowDetectionRow; now: number; context: DetectionContext }> = ({
  row,
  now,
  context,
}) => {
  if (row.group) return <CampaignGroupEvidence group={row.group} now={now} accounts={context.accounts} />;
  const peers = context.burstPeers.get(row.id);
  return (
    <Stack gap={0.25} data-testid="shadow-detection-dialog-actors" sx={{ minWidth: 0 }}>
      <Typography level="body-xs" sx={muted}>
        {row.userIds.length === 1 ? 'Account' : `Accounts (${row.userIds.length.toLocaleString()})`}
      </Typography>
      {row.userIds.length === 0 ? (
        <Dash />
      ) : (
        row.userIds.map(userId => (
          <AccountLine
            key={userId}
            userId={userId}
            account={context.accounts.get(userId)}
            linkTestId={`shadow-detection-dialog-user-link-${userId}`}
            testId={`shadow-detection-dialog-account-${userId}`}
          />
        ))
      )}
      {row.network && (
        <Typography level="body-xs" sx={{ ...muted, overflowWrap: 'anywhere' }}>
          {formatNetwork(row.network)}
        </Typography>
      )}
      {row.payment && <PaymentEvidence payment={row.payment} />}
      {peers && peers.userIds.length > 0 && (
        <Stack gap={0.25} data-testid="shadow-detection-dialog-burst-peers">
          <Typography level="body-xs" sx={muted}>
            Other signups from this IP in the window ({peerCount(peers)})
          </Typography>
          {peers.userIds.map(userId => (
            <AccountLine
              key={userId}
              userId={userId}
              account={context.accounts.get(userId)}
              linkTestId={`shadow-detection-dialog-user-link-${userId}`}
              testId={`shadow-detection-dialog-account-${userId}`}
            />
          ))}
          {peers.truncated && (
            <Typography level="body-xs" sx={muted}>
              More accounts signed up in this window than are listed.
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
};

// Fields where a digit is text, not a shortcut; radios and checkboxes still take the 1-4 keys.
const TEXT_ENTRY_SELECTOR =
  'textarea, input:not([type="radio"]):not([type="checkbox"]), select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';

/** Keys 1-4 pick the verdicts in SHADOW_DETECTION_VERDICTS order while a verdict dialog is open. */
const useVerdictShortcuts = (onPick: (verdict: ShadowDetectionVerdict) => void) => {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.target instanceof Element && event.target.closest(TEXT_ENTRY_SELECTOR)) return;
      const option = /^[1-9]$/.test(event.key) ? SHADOW_DETECTION_VERDICTS[Number(event.key) - 1] : undefined;
      if (!option) return;
      event.preventDefault();
      onPick(option);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onPick]);
};

/** Grading changes no account; this points the reviewer at where the account itself is acted on. */
const AbuseNextStep: React.FC<{ userIds: readonly string[] }> = ({ userIds }) => {
  if (userIds.length === 0) return null;
  return (
    <Typography level="body-xs" sx={muted} data-testid="shadow-detection-next-step">
      Looks like abuse?{' '}
      {userIds.length === 1 ? (
        <Link
          to="/admin/users/$userId"
          params={{ userId: userIds[0] }}
          data-testid="shadow-detection-next-step-link"
          style={{ color: 'inherit' }}
        >
          Suspend from the user page
        </Link>
      ) : (
        'Suspend each account from its user page, linked above'
      )}
      . Suspending with an abuse reason also grades its open detections.
    </Typography>
  );
};

const VerdictPicker: React.FC<{
  value: ShadowDetectionVerdict | null;
  onChange: (verdict: ShadowDetectionVerdict) => void;
}> = ({ value, onChange }) => {
  useVerdictShortcuts(onChange);
  return (
    <FormControl>
      <FormLabel>Verdict</FormLabel>
      <RadioGroup
        name="shadow-detection-verdict"
        value={value ?? ''}
        onChange={event => onChange(event.target.value as ShadowDetectionVerdict)}
      >
        {SHADOW_DETECTION_VERDICTS.map((option, index) => (
          <Radio
            key={option}
            value={option}
            label={
              <Stack gap={0.25} component="span">
                <Stack direction="row" gap={1} alignItems="center" component="span">
                  <span>{VERDICT_DISPLAY[option].label}</span>
                  <Kbd>{index + 1}</Kbd>
                </Stack>
                <Typography
                  component="span"
                  level="body-xs"
                  sx={muted}
                  data-testid={`shadow-detection-verdict-guide-${option}`}
                >
                  {VERDICT_GUIDES[option]}
                </Typography>
              </Stack>
            }
            slotProps={{ input: { 'data-testid': `shadow-detection-verdict-option-${option}` } }}
          />
        ))}
      </RadioGroup>
    </FormControl>
  );
};

/** A bulk result's leftovers, said once on the page; null when every detection was graded. */
export const bulkResultNotice = (result: ShadowDetectionBulkVerdictResult): string | null => {
  const parts = [
    result.conflicts.length > 0 &&
      `${countOf(result.conflicts.length, 'detection')} changed since this page loaded and kept their verdict`,
    result.notFound.length > 0 && `${countOf(result.notFound.length, 'detection')} no longer exist`,
  ].filter((part): part is string => !!part);
  if (parts.length === 0) return null;
  return `Graded ${countOf(result.updated.length, 'detection')}. ${parts.join('; ')}. Review them again.`;
};

type VerdictDialogProps = {
  row: ShadowDetectionRow;
  now: number;
  context: DetectionContext;
  onClose: () => void;
  onRowChange: (row: ShadowDetectionRow) => void;
  /** Present while another unreviewed detection follows this one: opens it after a successful grade. */
  onNext?: (gradedIds: readonly string[]) => void;
  onBulkResult: (result: ShadowDetectionBulkVerdictResult) => void;
};

// Choices are keyed by the row they were made for, so "Save and next" starts the next row blank while
// the reason draft (inside ActionDialog) carries over.
type RowChoice<T> = { rowId: string; value: T } | null;

const VerdictDialog: React.FC<VerdictDialogProps> = ({
  row,
  now,
  context,
  onClose,
  onRowChange,
  onNext,
  onBulkResult,
}) => {
  const single = useShadowDetectionVerdict();
  const bulk = useShadowDetectionBulkVerdict();
  const [verdictChoice, setVerdictChoice] = useState<RowChoice<ShadowDetectionVerdict>>(null);
  const [skipRelatedChoice, setSkipRelatedChoice] = useState<RowChoice<boolean>>(null);
  // The server's explanation of a stale verdict, or null when there is no conflict to show.
  const [conflictChoice, setConflictChoice] = useState<RowChoice<string>>(null);
  const forRow = <T,>(choice: RowChoice<T>): T | null => (choice?.rowId === row.id ? choice.value : null);
  const verdict = forRow(verdictChoice);
  const conflict = forRow(conflictChoice);
  const related = context.related.get(row.id) ?? EMPTY_RELATED;
  const applyRelated = related.length > 0 && forRow(skipRelatedChoice) !== true;
  const pickVerdict = useCallback(
    (value: ShadowDetectionVerdict) => setVerdictChoice({ rowId: row.id, value }),
    [row.id]
  );
  const title = row.verdict ? 'Change verdict' : 'Record verdict';
  const pending = single.isPending || bulk.isPending;
  const error = single.error ?? bulk.error;

  /** Records the verdict; the ids it graded, or null when this row conflicted and must be re-read. */
  const record = async (reason: string): Promise<string[] | null> => {
    if (!verdict) return null;
    setConflictChoice(null);
    if (!applyRelated) {
      const result = await single.mutateAsync({ id: row.id, expectedRevision: row.revision, verdict, reason });
      if (result.status === 'conflict') {
        onRowChange(result.item);
        setConflictChoice({ rowId: row.id, value: result.message ?? CONFLICT_FALLBACK_MESSAGE });
        return null;
      }
      return [row.id];
    }
    const targets = [row, ...related];
    const result = await bulk.mutateAsync({
      items: targets.map(target => ({ id: target.id, expectedRevision: target.revision })),
      verdict,
      reason,
    });
    const ownConflict = result.conflicts.find(item => item.id === row.id);
    if (ownConflict) {
      onRowChange(ownConflict);
      setConflictChoice({ rowId: row.id, value: CONFLICT_FALLBACK_MESSAGE });
      return null;
    }
    onBulkResult(result);
    return result.updated.map(item => item.id);
  };

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title={title}
      description="Grading measures the detector; it changes nothing on the account. There is no undo: to correct a verdict, record another one. Every verdict stays in the history."
      reasonPresets={ADMIN_REASON_PRESETS.shadowDetectionVerdict}
      confirmLabel={verdict ? `Record ${VERDICT_DISPLAY[verdict].label.toLowerCase()}` : 'Record verdict'}
      blockedReason={verdict ? null : 'Pick a verdict (keys 1-4).'}
      pending={pending}
      onConfirm={async reason => {
        if (await record(reason)) onClose();
      }}
      secondaryAction={
        onNext && {
          label: 'Save and next',
          onConfirm: async reason => {
            const graded = await record(reason);
            if (graded) onNext(graded);
          },
        }
      }
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
        <CurrentVerdictAttribution row={row} reviewers={context.reviewers} />
      </Stack>
      <DialogActors row={row} now={now} context={context} />
      <AbuseNextStep userIds={row.userIds} />
      {conflict && (
        <Alert color="warning" data-testid="shadow-detection-verdict-conflict">
          {conflict} Its current verdict and history are shown below.
        </Alert>
      )}
      {error && (
        <Alert color="danger" data-testid="shadow-detection-verdict-error">
          {getErrorMessage(error)}
        </Alert>
      )}
      <VerdictPicker value={verdict} onChange={pickVerdict} />
      {related.length > 0 && (
        <Checkbox
          checked={applyRelated}
          onChange={event => setSkipRelatedChoice({ rowId: row.id, value: !event.target.checked })}
          label={`Also record it on the ${countOf(related.length, 'other unreviewed detection')} naming this account`}
          slotProps={{ input: { 'data-testid': 'shadow-detection-apply-related-checkbox' } }}
        />
      )}
      <SignalList row={row} />
      {!SELF_ASSESSED_SHADOW_DETECTORS.includes(row.detector) && (
        <ShadowDetectionAssessmentPanel detectionId={row.id} enabled />
      )}
      <VerdictHistory row={row} now={now} reviewers={context.reviewers} />
    </ActionDialog>
  );
};

/** One verdict and one reason for the selected detections. */
const BulkVerdictDialog: React.FC<{
  rows: readonly ShadowDetectionRow[];
  onClose: () => void;
  onDone: (result: ShadowDetectionBulkVerdictResult) => void;
}> = ({ rows, onClose, onDone }) => {
  const bulk = useShadowDetectionBulkVerdict();
  const [verdict, setVerdict] = useState<ShadowDetectionVerdict | null>(null);
  const graded = rows.filter(row => row.verdict).length;
  return (
    <ActionDialog
      open
      onClose={() => {
        if (!bulk.isPending) onClose();
      }}
      title={`Record verdict on ${countOf(rows.length, 'detection')}`}
      description={`One verdict and one reason for every selected detection. It changes nothing on the accounts.${
        graded > 0 ? ` ${countOf(graded, 'selected detection')} already graded get this as a new verdict.` : ''
      } Detections graded by someone else since this page loaded are left alone.`}
      reasonPresets={ADMIN_REASON_PRESETS.shadowDetectionVerdict}
      confirmLabel={verdict ? `Record ${VERDICT_DISPLAY[verdict].label.toLowerCase()}` : 'Record verdict'}
      blockedReason={verdict ? null : 'Pick a verdict (keys 1-4).'}
      pending={bulk.isPending}
      onConfirm={async reason => {
        if (!verdict) return;
        const result = await bulk.mutateAsync({
          items: rows.map(row => ({ id: row.id, expectedRevision: row.revision })),
          verdict,
          reason,
        });
        onDone(result);
      }}
      data-testid="shadow-detection-bulk-verdict-dialog"
    >
      {bulk.error && (
        <Alert color="danger" data-testid="shadow-detection-bulk-verdict-error">
          {getErrorMessage(bulk.error)}
        </Alert>
      )}
      <VerdictPicker value={verdict} onChange={setVerdict} />
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
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  const [bulkGrading, setBulkGrading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [groupAccounts, setGroupAccounts] = useState(false);
  const [now] = useState(() => Date.now());

  const listed = detections.data?.data;
  const accounts = detections.data?.accounts;
  const burstPeers = detections.data?.burstPeers;
  const reviewers = detections.data?.reviewers;
  const context = useMemo<DetectionContext>(
    () => ({
      accounts: new Map((accounts ?? []).map(account => [account.userId, account])),
      burstPeers: new Map((burstPeers ?? []).map(peers => [peers.detectionId, peers])),
      related: relatedUnreviewed(listed ?? []),
      reviewers: new Map((reviewers ?? []).map(reviewer => [reviewer.userId, reviewer.name])),
    }),
    [listed, accounts, burstPeers, reviewers]
  );
  const accountGroups = useMemo(() => (groupAccounts ? groupByAccount(listed ?? []) : []), [groupAccounts, listed]);
  // Grouped rows sit together so a group never splits across the table's pages.
  const rows = useMemo(() => {
    const all = listed ?? [];
    if (accountGroups.length === 0) return all;
    const grouped = accountGroups.flatMap(group => group.rows);
    const groupedIds = new Set(grouped.map(row => row.id));
    return [...grouped, ...all.filter(row => !groupedIds.has(row.id))];
  }, [listed, accountGroups]);
  const tableGroups: DataTableGroup[] | undefined = groupAccounts
    ? accountGroups.map(group => ({
        id: group.userId,
        rowIds: group.rows.map(row => row.id),
        header: (
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <AccountLine
              userId={group.userId}
              account={context.accounts.get(group.userId)}
              linkTestId={`shadow-detection-group-user-link-${group.userId}`}
              testId={`shadow-detection-group-account-${group.userId}`}
            />
            <Typography level="body-xs" sx={muted}>
              {countOf(group.rows.length, 'detection')}
            </Typography>
          </Stack>
        ),
      }))
    : undefined;
  const selectedRows = selection.mode === 'allMatching' ? rows : rows.filter(row => selection.ids.includes(row.id));

  /** The next unreviewed row after `current` in table order, skipping the ones just graded. */
  const nextUnreviewed = (current: ShadowDetectionRow, graded: readonly string[]) => {
    const skip = new Set([current.id, ...graded]);
    const index = rows.findIndex(row => row.id === current.id);
    return [...rows.slice(index + 1), ...rows.slice(0, Math.max(index, 0))].find(
      row => !row.verdict && !skip.has(row.id)
    );
  };
  const nextAfterGrading = grading ? nextUnreviewed(grading, []) : undefined;
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
      help: <TermHelp term="would" />,
      render: row => (
        <StatusChip
          tone={ACTION_DISPLAY[row.wouldAction].tone}
          label={ACTION_DISPLAY[row.wouldAction].label}
          data-testid={`shadow-detection-action-${row.id}`}
        />
      ),
      sortValue: row => ACTION_DISPLAY[row.wouldAction].label,
      width: '8.5rem',
    },
    { id: 'actor', label: 'Actor', render: row => <Actor row={row} context={context} />, width: '18rem' },
    {
      id: 'verdict',
      label: 'Verdict',
      render: row => (
        <Stack gap={0.25} alignItems="flex-start" sx={{ minWidth: 0 }}>
          <VerdictChip verdict={row.verdict} testId={`shadow-detection-verdict-${row.id}`} />
          <RowVerdictAttribution row={row} reviewers={context.reviewers} />
        </Stack>
      ),
      sortValue: row => (row.verdict ? VERDICT_DISPLAY[row.verdict].label : ''),
      width: '11rem',
    },
  ];

  const rowActions = (row: ShadowDetectionRow) => {
    const label = row.verdict ? 'Change verdict' : 'Record verdict';
    return (
      <Tooltip title={label}>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={label}
          data-testid={`shadow-detection-grade-btn-${row.id}`}
          onClick={() => setGrading(row)}
        >
          <RateReviewOutlinedIcon />
        </IconButton>
      </Tooltip>
    );
  };

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
      <DetectionsIntro />
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
      <VerdictEvalPanel />
      {detections.data?.truncated && (
        <Alert color="warning" data-testid="shadow-detection-truncated">
          Showing the {SHADOW_DETECTION_LIST_LIMIT.toLocaleString()} most recent detections. Narrow the filters to see
          older ones.
        </Alert>
      )}
      {notice && (
        <Alert
          color="warning"
          data-testid="shadow-detection-bulk-notice"
          endDecorator={
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setNotice(null)}
              data-testid="shadow-detection-bulk-notice-dismiss-btn"
            >
              Dismiss
            </Button>
          }
        >
          {notice}
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
      <Switch
        checked={groupAccounts}
        onChange={event => setGroupAccounts(event.target.checked)}
        endDecorator="Group detections by account"
        slotProps={{ input: { 'data-testid': 'shadow-detection-group-toggle' } }}
        sx={{ alignSelf: 'flex-start', color: 'admin.ink' }}
      />
      <DataTable
        rows={rows}
        columns={columns}
        label="Shadow detections"
        getRowId={row => row.id}
        selection={selection}
        onSelectionChange={setSelection}
        groups={tableGroups}
        pageResetKey={JSON.stringify([detector, verdict, groupAccounts])}
        testId="shadow-detection-table"
        rowTestId={row => `shadow-detection-row-${row.id}`}
        loading={detections.isPending}
        error={detections.error ? "Couldn't load detections." : undefined}
        onRetry={() => void detections.refetch()}
        onRowActivate={setGrading}
        rowActions={rowActions}
        // The fixed-width columns plus room for the summary; narrower screens scroll sideways.
        minWidth="76rem"
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
      <BulkActionBar
        selection={selection}
        totalMatching={rows.length}
        onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
        onClear={() => setSelection({ mode: 'explicit', ids: [] })}
      >
        <Button size="sm" onClick={() => setBulkGrading(true)} data-testid="shadow-detection-bulk-grade-btn">
          Record verdict
        </Button>
      </BulkActionBar>
      {grading && (
        <VerdictDialog
          row={grading}
          now={now}
          context={context}
          onClose={() => setGrading(null)}
          onRowChange={setGrading}
          onNext={nextAfterGrading ? graded => setGrading(nextUnreviewed(grading, graded) ?? null) : undefined}
          onBulkResult={result => setNotice(bulkResultNotice(result))}
        />
      )}
      {bulkGrading && selectedRows.length > 0 && (
        <BulkVerdictDialog
          rows={selectedRows}
          onClose={() => setBulkGrading(false)}
          onDone={result => {
            setBulkGrading(false);
            setSelection({ mode: 'explicit', ids: [] });
            setNotice(bulkResultNotice(result));
          }}
        />
      )}
    </Stack>
  );
};

export default ShadowDetectionsTab;
