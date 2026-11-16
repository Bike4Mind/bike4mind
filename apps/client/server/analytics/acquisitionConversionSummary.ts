import { COHORT_WINDOW_MAX_DAYS } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { COHORT_MAX_TIME_MS, withinBudget } from '@bike4mind/server-utils/analytics/activationFunnel';
import {
  ACQUISITION_BUDGET_MS,
  attributedSignups,
  conversionOutcomes,
  type AttributedSignup,
  type MemberOutcome,
} from '@bike4mind/server-utils/analytics/acquisitionConversion';
import { shiftDay } from '@bike4mind/server-utils/analytics/analyticsRollup';
import { signupVerdictUserIds } from '@bike4mind/server-utils/analytics/realSignup';
import {
  ACQUISITION_OTHER_KEY,
  ACQUISITION_TOP_ROWS,
  ACQUISITION_UNATTRIBUTED_KEY,
  type AcquisitionConversion,
  type AcquisitionMetrics,
  type AcquisitionQuery,
  type AcquisitionRow,
} from '@client/app/utils/acquisitionConversion';
import { daysBetween, resolveOverviewWindow } from './analyticsOverview';

const emptyMetrics = (): AcquisitionMetrics => ({
  signups: 0,
  matureSignups: 0,
  converted: 0,
  subscriptionFirst: 0,
  creditFirst: 0,
  both: 0,
  provisionalConverted: 0,
  provisional: false,
  conversionPct: null,
  orgBuyers: 0,
  retained: 0,
  followUpBuyers: 0,
  followUpPending: 0,
  repeatCredit: 0,
  renewalDue: 0,
  renewed: 0,
  renewalUnavailable: 0,
});

function addOutcome(metrics: AcquisitionMetrics, outcome: MemberOutcome | undefined): void {
  metrics.signups++;
  if (!outcome) return;
  const { firstPaid, followUp } = outcome;
  if (!outcome.mature) {
    if (firstPaid) metrics.provisionalConverted++;
    return;
  }
  metrics.matureSignups++;
  if (outcome.orgBuyer) metrics.orgBuyers++;
  if (!firstPaid) return;
  metrics.converted++;
  if (firstPaid.kind === 'subscription') metrics.subscriptionFirst++;
  else metrics.creditFirst++;
  if (firstPaid.both) metrics.both++;
  if (outcome.retained) metrics.retained++;
  if (!followUp) {
    metrics.followUpPending++;
    return;
  }
  metrics.followUpBuyers++;
  if (followUp.repeatCredit) metrics.repeatCredit++;
  if (followUp.renewal === 'unavailable') metrics.renewalUnavailable++;
  if (followUp.renewal === 'renewed' || followUp.renewal === 'notRenewed') metrics.renewalDue++;
  if (followUp.renewal === 'renewed') metrics.renewed++;
}

function addMetrics(into: AcquisitionMetrics, from: AcquisitionMetrics): void {
  for (const key of Object.keys(into) as (keyof AcquisitionMetrics)[]) {
    const value = from[key];
    if (typeof value === 'number') (into[key] as number) += value;
  }
}

function finish<T extends AcquisitionMetrics>(metrics: T): T {
  metrics.provisional = metrics.matureSignups < metrics.signups;
  metrics.conversionPct = metrics.matureSignups === 0 ? null : (metrics.converted / metrics.matureSignups) * 100;
  return metrics;
}

/**
 * Rows by signups (desc, then key): every touch row up to ACQUISITION_TOP_ROWS, the rest summed into one
 * `other` row, then the unattributed row. `other` and unattributed are only present when non-empty.
 */
export function groupAcquisitionRows(
  members: readonly AttributedSignup[],
  outcomes: ReadonlyMap<string, MemberOutcome> = new Map()
): {
  rows: AcquisitionRow[];
  totals: AcquisitionMetrics;
  truncated: boolean;
} {
  const byKey = new Map<string, AcquisitionRow>();
  const blankRow = (kind: AcquisitionRow['kind'], key: string): AcquisitionRow => ({
    kind,
    key,
    source: null,
    medium: null,
    campaign: null,
    ...emptyMetrics(),
  });
  const unattributed = blankRow('unattributed', ACQUISITION_UNATTRIBUTED_KEY);
  const totals = emptyMetrics();
  for (const { id, touch } of members) {
    const outcome = outcomes.get(id);
    addOutcome(totals, outcome);
    if (!touch) {
      addOutcome(unattributed, outcome);
      continue;
    }
    let row = byKey.get(touch.key);
    if (!row) {
      row = { ...blankRow('touch', touch.key), source: touch.source, medium: touch.medium, campaign: touch.campaign };
      byKey.set(touch.key, row);
    }
    addOutcome(row, outcome);
  }
  const sorted = [...byKey.values()].sort((a, b) => b.signups - a.signups || a.key.localeCompare(b.key));
  const rows = sorted.slice(0, ACQUISITION_TOP_ROWS);
  const rest = sorted.slice(ACQUISITION_TOP_ROWS);
  if (rest.length > 0) {
    const other = blankRow('other', ACQUISITION_OTHER_KEY);
    for (const row of rest) addMetrics(other, row);
    rows.push(other);
  }
  if (unattributed.signups > 0) rows.push(unattributed);
  return { rows: rows.map(finish), totals: finish(totals), truncated: rest.length > 0 };
}

/**
 * Signups in the query's range grouped by first- or last-touch campaign, with `signups=legit` keeping only
 * the real-signup verdict's legit ids (the same intersection the activation funnel makes). Ranges longer
 * than the Users drill-down accepts are not computed.
 */
export async function getAcquisitionConversion(query: AcquisitionQuery, now: Date): Promise<AcquisitionConversion> {
  const resolved = resolveOverviewWindow(query, now);
  if (daysBetween(resolved.from, resolved.to).length > COHORT_WINDOW_MAX_DAYS) {
    return { status: 'rangeTooLong', maxDays: COHORT_WINDOW_MAX_DAYS };
  }
  const createdFrom = `${resolved.from}T00:00:00.000Z`;
  const createdTo = `${shiftDay(resolved.to, 1)}T00:00:00.000Z`;
  const window = { start: new Date(createdFrom), end: new Date(createdTo) };
  const expiresAt = Date.now() + ACQUISITION_BUDGET_MS;
  const timeLeft = () => Math.max(1, Math.min(COHORT_MAX_TIME_MS, expiresAt - Date.now()));

  const [cohort, legitIds] = await withinBudget(
    Promise.all([
      attributedSignups(window, { touch: query.touch, maxTimeMS: timeLeft }),
      query.signups === 'legit'
        ? signupVerdictUserIds({ ...window, verdict: 'legit' }, { deadlineMs: timeLeft() })
        : undefined,
    ]),
    expiresAt
  );
  const legit = legitIds && new Set(legitIds);
  const members = legit ? cohort.filter(member => legit.has(member.id)) : cohort;
  const attributed = members.filter(member => member.touch).length;
  const conversionWindowDays = Number(query.window);
  const followUpDays = Number(query.followUp);
  const outcomes = await withinBudget(
    conversionOutcomes(members, { windowDays: conversionWindowDays, followUpDays, now, maxTimeMS: timeLeft }),
    expiresAt
  );
  const { rows, totals, truncated } = groupAcquisitionRows(members, outcomes);
  return {
    status: 'ok',
    signups: query.signups,
    touch: query.touch,
    window: { createdFrom, createdTo },
    coverage: {
      signups: members.length,
      attributed,
      pct: members.length === 0 ? null : (attributed / members.length) * 100,
    },
    conversionWindowDays,
    followUpDays,
    renewalBasis: 'subscription-state',
    totals,
    rows,
    truncated,
  };
}
