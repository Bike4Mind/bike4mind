import { internalStaffEmailRegex, parseInternalStaffDomains } from '@bike4mind/common';

/**
 * Pure aggregation for the external DAU / cohort retention report (no DB access): the user-day map,
 * exclusions, DAU series, cohorts, arg parsing and formatting. The reads live in
 * ./externalActiveUsersReport.ts.
 *
 * An active user-day is a distinct userId with at least one UsageEvent (status ok), Quest chat
 * message or AgentExecution on a UTC day. Days are carried as integer UTC epoch days so retention
 * offsets are plain subtraction.
 */

export const DEFAULT_DAYS = 120;
/** Source of the default --test-pattern regex (compiled case-insensitive). */
export const DEFAULT_TEST_PATTERN = String.raw`\+(e2e|test)`;
export const DAU_DAYS = 30;
export const RETENTION_OFFSETS = [1, 7, 30] as const;
export type RetentionOffset = (typeof RETENTION_OFFSETS)[number];

/** AgentExecution rows carry a 90-day TTL index, so agent-only activity older than this is gone. */
export const AGENT_EXECUTION_TTL_DAYS = 90;

const MS_PER_DAY = 86_400_000;
const UNSET_SOURCE = 'unset';

export const toUtcDay = (date: Date): number => Math.floor(date.getTime() / MS_PER_DAY);
export const formatUtcDay = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

/** Epoch day 0 (1970-01-01) was a Thursday, so Sunday-based weekday is (day + 4) % 7. */
const utcWeekStart = (day: number): number => day - ((day + 4) % 7);

// --- Args ---

export interface ReportArgs {
  help: boolean;
  days: number;
  testPattern: RegExp;
}

export const HELP_TEXT = `Report external DAU and weekly cohort retention (read-only).

Usage: report:external-active-users [--days <n>] [--test-pattern <regex>] [--help]

  --days <n>             Window in UTC days, ending today (default ${DEFAULT_DAYS}).
  --test-pattern <regex> Exclude users whose email matches (case-insensitive).
                         Default: ${DEFAULT_TEST_PATTERN}
  --help                 Show this text.

An active user-day is a distinct userId with a UsageEvent (status ok), a Quest chat message or an
AgentExecution on a UTC day. Excluded: admins, emails ending in a NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
domain, emails matching --test-pattern, and userIds with no User document.

Cohort = week (UTC Sunday start) of the user's first active day in the window. Users whose first
day is the window start are skipped (they may predate it). D-N is the share of the cohort active
exactly N days after their first day; '-' means the cohort's newest possible member has fewer than
N full days behind them.

Env: MONGODB_URI (or the SST config), NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS (comma-separated).`;

/** `args` is argv without the node and script entries. Unknown flags throw so typos do not run silently. */
export function parseReportArgs(args: string[]): ReportArgs {
  let help = false;
  let days = DEFAULT_DAYS;
  let patternSource = DEFAULT_TEST_PATTERN;

  for (let i = 0; i < args.length; i++) {
    const eq = args[i].indexOf('=');
    const flag = eq === -1 ? args[i] : args[i].slice(0, eq);
    if (flag === '--help' || flag === '-h') {
      help = true;
      continue;
    }
    if (flag !== '--days' && flag !== '--test-pattern') throw new Error(`Unknown argument: ${args[i]}`);
    const value = eq === -1 ? args[++i] : args[i].slice(eq + 1);
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--days') {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('--days needs a positive integer');
      days = Number(value);
    } else {
      patternSource = value;
    }
  }

  let testPattern: RegExp;
  try {
    testPattern = new RegExp(patternSource, 'i');
  } catch {
    throw new Error(`--test-pattern is not a valid regex: ${patternSource}`);
  }
  return { help, days, testPattern };
}

// --- User-day map ---

/** userId -> set of UTC epoch days with at least one qualifying action. */
export type UserDayMap = Map<string, Set<number>>;

/** Any number of actions by one user on one UTC day collapse to a single entry. */
export function recordActivity(userDays: UserDayMap, userId: string, at: Date): void {
  let days = userDays.get(userId);
  if (!days) {
    days = new Set();
    userDays.set(userId, days);
  }
  days.add(toUtcDay(at));
}

/** userId -> UsageEvent row count per source; a missing source is kept as 'unset'. */
export type UserSourceCounts = Map<string, Map<string, number>>;

export function recordUsageSource(counts: UserSourceCounts, userId: string, source: string | null | undefined): void {
  const key = source || UNSET_SOURCE;
  let bySource = counts.get(userId);
  if (!bySource) {
    bySource = new Map();
    counts.set(userId, bySource);
  }
  bySource.set(key, (bySource.get(key) ?? 0) + 1);
}

// --- Exclusions ---

export type ExclusionReason = 'noUser' | 'admin' | 'staffDomain' | 'testPattern';

export interface UserRecord {
  email?: string | null;
  isAdmin?: boolean | null;
}

export interface ExclusionRules {
  /** Null when no staff domains are configured: nothing is excluded on that basis. */
  staffEmail: RegExp | null;
  testEmail: RegExp;
}

export function buildExclusionRules(staffDomainsEnv: string | undefined, testPattern: RegExp): ExclusionRules {
  return { staffEmail: internalStaffEmailRegex(parseInternalStaffDomains(staffDomainsEnv)), testEmail: testPattern };
}

/** First matching reason, checked in the order of ExclusionReason; null means the user is external. */
export function exclusionReason(user: UserRecord | undefined, rules: ExclusionRules): ExclusionReason | null {
  if (!user) return 'noUser';
  if (user.isAdmin) return 'admin';
  const email = user.email ?? '';
  if (rules.staffEmail?.test(email)) return 'staffDomain';
  if (rules.testEmail.test(email)) return 'testPattern';
  return null;
}

export function selectExternal(
  userDays: UserDayMap,
  users: Map<string, UserRecord>,
  rules: ExclusionRules
): { external: UserDayMap; excluded: Record<ExclusionReason, number> } {
  const external: UserDayMap = new Map();
  const excluded: Record<ExclusionReason, number> = { noUser: 0, admin: 0, staffDomain: 0, testPattern: 0 };
  for (const [userId, days] of userDays) {
    const reason = exclusionReason(users.get(userId), rules);
    if (reason) excluded[reason] += 1;
    else external.set(userId, days);
  }
  return { external, excluded };
}

// --- Series ---

export interface DauRow {
  day: string;
  users: number;
}

/** DAU for the `days` UTC days ending at `lastDay` inclusive; days with no activity are zero rows. */
export function dauSeries(userDays: UserDayMap, lastDay: number, days: number): DauRow[] {
  const firstDay = lastDay - days + 1;
  const counts = new Array<number>(days).fill(0);
  for (const activeDays of userDays.values()) {
    for (const day of activeDays) {
      if (day >= firstDay && day <= lastDay) counts[day - firstDay] += 1;
    }
  }
  return counts.map((users, i) => ({ day: formatUtcDay(firstDay + i), users }));
}

export interface SourceRow {
  source: string;
  rows: number;
}

/** UsageEvent rows by source across the users in `external`, biggest first. */
export function countRowsBySource(sourceCounts: UserSourceCounts, external: UserDayMap): SourceRow[] {
  const totals = new Map<string, number>();
  for (const [userId, bySource] of sourceCounts) {
    if (!external.has(userId)) continue;
    for (const [source, rows] of bySource) totals.set(source, (totals.get(source) ?? 0) + rows);
  }
  return [...totals]
    .map(([source, rows]) => ({ source, rows }))
    .sort((a, b) => b.rows - a.rows || a.source.localeCompare(b.source));
}

export interface CohortRow {
  weekStart: string;
  users: number;
  /** Percent of the cohort active exactly N days after their first day; null when the cohort is too young. */
  retention: Record<RetentionOffset, number | null>;
}

export interface CohortTable {
  rows: CohortRow[];
  /** Users whose first active day is the window start: they may predate it, so they are not a cohort. */
  skippedAtWindowStart: number;
}

/**
 * Weekly cohorts by first active day. Today is a partial day, so a D-N value is measured only when
 * the cohort's last possible first day (week start + 6) plus N is at most yesterday; that keeps a
 * cohort's members all measurable or all not, instead of biasing toward early joiners.
 */
export function buildCohorts(
  userDays: UserDayMap,
  { todayDay, windowStartDay }: { todayDay: number; windowStartDay: number }
): CohortTable {
  const weeks = new Map<number, { users: number; retained: Record<RetentionOffset, number> }>();
  let skippedAtWindowStart = 0;

  for (const activeDays of userDays.values()) {
    if (activeDays.size === 0) continue;
    const firstDay = Math.min(...activeDays);
    if (firstDay === windowStartDay) {
      skippedAtWindowStart += 1;
      continue;
    }
    const week = utcWeekStart(firstDay);
    let cohort = weeks.get(week);
    if (!cohort) {
      cohort = { users: 0, retained: { 1: 0, 7: 0, 30: 0 } };
      weeks.set(week, cohort);
    }
    cohort.users += 1;
    for (const offset of RETENTION_OFFSETS) {
      if (activeDays.has(firstDay + offset)) cohort.retained[offset] += 1;
    }
  }

  const rows = [...weeks]
    .sort(([a], [b]) => a - b)
    .map(([week, cohort]): CohortRow => {
      const retention = { 1: null, 7: null, 30: null } as CohortRow['retention'];
      for (const offset of RETENTION_OFFSETS) {
        if (week + 6 + offset <= todayDay - 1) retention[offset] = (cohort.retained[offset] / cohort.users) * 100;
      }
      return { weekStart: formatUtcDay(week), users: cohort.users, retention };
    });
  return { rows, skippedAtWindowStart };
}

// --- Report ---

export interface ExternalActivityReport {
  today: string;
  windowStart: string;
  days: number;
  externalUsers: number;
  excluded: Record<ExclusionReason, number>;
  staffExclusionConfigured: boolean;
  dau: DauRow[];
  sources: SourceRow[];
  cohorts: CohortTable;
}

export function buildReport(input: {
  userDays: UserDayMap;
  sourceCounts: UserSourceCounts;
  users: Map<string, UserRecord>;
  rules: ExclusionRules;
  days: number;
  now: Date;
}): ExternalActivityReport {
  const { userDays, sourceCounts, users, rules, days, now } = input;
  const todayDay = toUtcDay(now);
  const windowStartDay = todayDay - days + 1;
  const { external, excluded } = selectExternal(userDays, users, rules);
  return {
    today: formatUtcDay(todayDay),
    windowStart: formatUtcDay(windowStartDay),
    days,
    externalUsers: external.size,
    excluded,
    staffExclusionConfigured: rules.staffEmail !== null,
    dau: dauSeries(external, todayDay, Math.min(DAU_DAYS, days)),
    sources: countRowsBySource(sourceCounts, external),
    cohorts: buildCohorts(external, { todayDay, windowStartDay }),
  };
}

const pad = (cells: string[], widths: number[]): string =>
  cells
    .map((c, i) => c.padEnd(widths[i]))
    .join('  ')
    .trimEnd();
const percent = (value: number | null): string => (value === null ? '-' : `${value.toFixed(1)}%`);

export function formatReport(report: ExternalActivityReport): string {
  const { excluded } = report;
  const lines: string[] = [
    `External activity, ${report.windowStart} to ${report.today} UTC (${report.days} days)`,
    `External users with activity: ${report.externalUsers}`,
    `Excluded users: ${excluded.admin} admin, ${excluded.staffDomain} staff domain, ` +
      `${excluded.testPattern} test pattern, ${excluded.noUser} no User doc`,
  ];
  if (!report.staffExclusionConfigured) {
    lines.push('WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty, so no staff-domain exclusion was applied.');
  }
  if (report.days > AGENT_EXECUTION_TTL_DAYS) {
    lines.push(
      `Note: AgentExecution rows expire after ${AGENT_EXECUTION_TTL_DAYS} days, so agent-only activity ` +
        `before ${AGENT_EXECUTION_TTL_DAYS} days ago is not counted.`
    );
  }

  lines.push('', `DAU (UTC, last ${report.dau.length} days)`);
  for (const row of report.dau) {
    lines.push(pad([row.day, String(row.users)], [10, 5]) + (row.day === report.today ? '  (partial day)' : ''));
  }

  lines.push('', 'UsageEvent rows by source (status ok, external users, whole window)');
  if (report.sources.length === 0) lines.push('(none)');
  const sourceWidth = Math.max(6, ...report.sources.map(s => s.source.length));
  for (const row of report.sources) lines.push(pad([row.source, String(row.rows)], [sourceWidth, 8]));

  lines.push('', 'Weekly cohorts (first active day in the window, UTC Sunday start)');
  lines.push(pad(['Cohort', 'Users', 'D1', 'D7', 'D30'], [10, 6, 7, 7, 7]));
  for (const row of report.cohorts.rows) {
    lines.push(
      pad(
        [
          row.weekStart,
          String(row.users),
          percent(row.retention[1]),
          percent(row.retention[7]),
          percent(row.retention[30]),
        ],
        [10, 6, 7, 7, 7]
      )
    );
  }
  lines.push(`Skipped ${report.cohorts.skippedAtWindowStart} user(s) whose first active day is the window start.`);
  return lines.join('\n');
}
