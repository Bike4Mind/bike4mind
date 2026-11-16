import { COHORT_WINDOW_MAX_DAYS } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { COHORT_MAX_TIME_MS } from '@bike4mind/server-utils/analytics/activationFunnel';
import { attributedSignups, type AttributedSignup } from '@bike4mind/server-utils/analytics/acquisitionConversion';
import { shiftDay } from '@bike4mind/server-utils/analytics/analyticsRollup';
import { signupVerdictUserIds } from '@bike4mind/server-utils/analytics/realSignup';
import {
  ACQUISITION_OTHER_KEY,
  ACQUISITION_TOP_ROWS,
  ACQUISITION_UNATTRIBUTED_KEY,
  type AcquisitionConversion,
  type AcquisitionQuery,
  type AcquisitionRow,
} from '@client/app/utils/acquisitionConversion';
import { withinBudget } from './activationFunnelSummary';
import { daysBetween, resolveOverviewWindow } from './analyticsOverview';

// ms. The whole request, kept well inside the 60s API Lambda so a slow read fails with a handled 504.
const ACQUISITION_BUDGET_MS = 40_000;

/**
 * Rows by signups (desc, then key): every touch row up to ACQUISITION_TOP_ROWS, the rest summed into one
 * `other` row, then the unattributed row. `other` and unattributed are only present when non-empty.
 */
export function groupAcquisitionRows(members: readonly AttributedSignup[]): {
  rows: AcquisitionRow[];
  truncated: boolean;
} {
  const byKey = new Map<string, AcquisitionRow>();
  let unattributed = 0;
  for (const { touch } of members) {
    if (!touch) {
      unattributed++;
      continue;
    }
    const row = byKey.get(touch.key);
    if (row) row.signups++;
    else
      byKey.set(touch.key, {
        kind: 'touch',
        key: touch.key,
        source: touch.source,
        medium: touch.medium,
        campaign: touch.campaign,
        signups: 1,
      });
  }
  const sorted = [...byKey.values()].sort((a, b) => b.signups - a.signups || a.key.localeCompare(b.key));
  const rows = sorted.slice(0, ACQUISITION_TOP_ROWS);
  const rest = sorted.slice(ACQUISITION_TOP_ROWS);
  if (rest.length > 0) {
    rows.push({
      kind: 'other',
      key: ACQUISITION_OTHER_KEY,
      source: null,
      medium: null,
      campaign: null,
      signups: rest.reduce((sum, row) => sum + row.signups, 0),
    });
  }
  if (unattributed > 0) {
    rows.push({
      kind: 'unattributed',
      key: ACQUISITION_UNATTRIBUTED_KEY,
      source: null,
      medium: null,
      campaign: null,
      signups: unattributed,
    });
  }
  return { rows, truncated: rest.length > 0 };
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
  const { rows, truncated } = groupAcquisitionRows(members);
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
    rows,
    truncated,
  };
}
