import { internalStaffEmailRegex, parseInternalStaffDomains } from '@bike4mind/common';

/**
 * Pure aggregation for the external DAU / cohort retention report (no DB access): the user-day map,
 * exclusions, DAU series, cohorts, arg parsing and formatting. The reads live in
 * ./externalActiveUsersReport.ts.
 *
 * An active user-day is a distinct userId with at least one UsageEvent (status ok), Quest chat
 * message or AgentExecution on a UTC day. Public API activity (UsageEvent source 'api', API-key
 * AgentExecutions) is kept in a separate user-day map: it is reported as "API users" and never
 * counts toward DAU, activation or retention. Internal users (admins, staff domains) are split out
 * of the app map into their own daily series and never enter an external figure. Days are carried as
 * integer UTC epoch days so retention offsets are plain subtraction.
 */

export const DEFAULT_DAYS = 90;
/** Source of the default --test-pattern regex (compiled case-insensitive). */
export const DEFAULT_TEST_PATTERN = String.raw`\+(e2e|test)`;
export const DAU_DAYS = 30;
export const RETENTION_OFFSETS = [1, 7, 30] as const;
export type RetentionOffset = (typeof RETENTION_OFFSETS)[number];

/** AgentExecution rows carry a 90-day TTL index, so agent-only activity older than this is gone. */
export const AGENT_EXECUTION_TTL_DAYS = 90;

/** Max gap between a Quest's ObjectId creation time and its `timestamp` for it to count as an original. */
export const QUEST_COPY_SKEW_MS = 3_600_000;

const MS_PER_DAY = 86_400_000;
const UNSET_SOURCE = 'unset';
/** UsageEvent.source stamped on public API calls; an unset source is treated as the app. */
export const API_SOURCE = 'api';

export const isApiSource = (source: string | null | undefined): boolean => source === API_SOURCE;

export const toUtcDay = (date: Date): number => Math.floor(date.getTime() / MS_PER_DAY);
export const formatUtcDay = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

/** UTC midnight of the first day of a `days`-day window ending on the UTC day of `now`. */
export const windowStartDay = (now: Date, days: number): Date => new Date((toUtcDay(now) - days + 1) * MS_PER_DAY);

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

  --days <n>             Window in UTC days, ending today (default ${DEFAULT_DAYS}). Larger values are
                         accepted, but agent activity older than ${AGENT_EXECUTION_TTL_DAYS} days is missing
                         (AgentExecution TTL), so cohorts before that point are unreliable.
  --test-pattern <regex> Exclude users whose email matches (case-insensitive).
                         Default: ${DEFAULT_TEST_PATTERN}
  --help                 Show this text.

An active user-day is a distinct userId with a UsageEvent (status ok), a Quest chat message or an
AgentExecution (any status: starting a run is the user's action, a failure is ours) on a UTC day.
DAU is web app + CLI + desktop activity only. Public API activity is reported separately as "API users" (users
with at least one API-sourced action that day, whether or not they are also in DAU) and never
activates or retains a cohort user. API activity means a UsageEvent with source 'api' or an
AgentExecution started with an API key (plus the Quest that run wrote). An unset UsageEvent source
counts as the app.
Excluded: admins, emails ending in a NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS domain, emails matching
--test-pattern, and userIds with no User document.
Internal users are the admins and staff-domain accounts above. They stay out of DAU, API users,
cohorts and the per-source rows, and show in their own "Internal" column: users with a web app, CLI
or desktop action that day (API-only activity is not counted, as for DAU). Test-pattern and
no-User-doc accounts are in neither.

Known gaps in the API split:
- POST /api/chat turns are stamped source 'web' on their UsageEvent, and a Quest carries no API-key
  marker, so public chat API activity is still counted in DAU (overcount).
- CLI usage recorded before the CLI source fix deployed is stored as 'api', so DAU undercounts the
  CLI early in a window that predates that deploy, and those users show up as API users.
- Desktop usage recorded before the 'desktop' source deployed is stored as 'api', with the same
  undercount and the same effect on API users.

Cohort = external users whose User.createdAt falls inside the window, grouped by the UTC Sunday-start
week of their signup day. Users who signed up before the window count toward DAU but are in no
cohort. Signups counts every in-window signup, including users who never became active; Activated
is the share with at least one active day (API activity does not count). D-N is retained / Signups,
where retained means active exactly N days after the signup day. '-' means the cohort's newest
possible signup has fewer than N full days behind them; a shown D-N therefore always covers every
signup in the cohort. The first cohort can be partial: it holds only signups from the window start.

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

/**
 * Session clone, fork and snip copy quests with the source `timestamp` but a fresh _id, and rebind
 * the session to the copier, so a copy's _id is newer than its timestamp and must not credit the
 * copier on a past day. One-sided: a retry keeps its _id and moves timestamp forward
 * (ChatCompletionInvoke in b4m-core/services), which is real activity. `createdAt` is not used: the
 * copy may spread it from the source.
 */
export function isOriginalQuest(id: { getTimestamp(): Date }, timestamp: Date): boolean {
  return id.getTimestamp().getTime() - timestamp.getTime() <= QUEST_COPY_SKEW_MS;
}

// --- Exclusions ---

export type ExclusionReason = 'noUser' | 'admin' | 'staffDomain' | 'testPattern';

export interface UserRecord {
  email?: string | null;
  isAdmin?: boolean | null;
  createdAt?: Date | null;
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

/**
 * The entries of `userDays` whose user is internal staff: an admin or a staff-domain account. A
 * test-pattern email is left out even on the staff domain, so e2e accounts don't inflate the column.
 */
export function selectInternal(
  userDays: UserDayMap,
  users: Map<string, UserRecord>,
  rules: ExclusionRules
): UserDayMap {
  const internal: UserDayMap = new Map();
  for (const [userId, days] of userDays) {
    const user = users.get(userId);
    const reason = exclusionReason(user, rules);
    if (reason !== 'admin' && reason !== 'staffDomain') continue;
    if (rules.testEmail.test(user?.email ?? '')) continue;
    internal.set(userId, days);
  }
  return internal;
}

/** Union of user-day maps; a user active in more than one keeps every day. */
export function mergeUserDays(...maps: UserDayMap[]): UserDayMap {
  const merged: UserDayMap = new Map();
  for (const map of maps) {
    for (const [userId, days] of map) {
      let into = merged.get(userId);
      if (!into) {
        into = new Set();
        merged.set(userId, into);
      }
      for (const day of days) into.add(day);
    }
  }
  return merged;
}

/** The entries of `userDays` whose user is also in `keep`. */
export function restrictUsers(userDays: UserDayMap, keep: UserDayMap): UserDayMap {
  const restricted: UserDayMap = new Map();
  for (const [userId, days] of userDays) if (keep.has(userId)) restricted.set(userId, days);
  return restricted;
}

/** userId -> UTC signup day for external users with a createdAt, whether or not they were ever active. */
export function selectExternalSignups(users: Map<string, UserRecord>, rules: ExclusionRules): Map<string, number> {
  const signups = new Map<string, number>();
  for (const [userId, user] of users) {
    if (user.createdAt && exclusionReason(user, rules) === null) signups.set(userId, toUtcDay(user.createdAt));
  }
  return signups;
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
  /** External signups in the window that week, active or not. */
  signups: number;
  /** Signups with at least one active day. */
  activated: number;
  /** Percent of signups that activated. */
  activatedPercent: number;
  /** Percent of signups active exactly N days after their signup day; null when the cohort is too young. */
  retention: Record<RetentionOffset, number | null>;
}

export interface CohortTable {
  rows: CohortRow[];
}

/**
 * Weekly cohorts by signup week. Today is a partial day, so a D-N value is measured only when the
 * cohort's last possible signup day (week start + 6) plus N is at most yesterday; that keeps a
 * cohort's members all measurable or all not, instead of biasing toward early signups. Signups
 * before `windowFirstDay` are not in any cohort.
 */
export function buildCohorts(
  userDays: UserDayMap,
  signups: Map<string, number>,
  { todayDay, windowFirstDay }: { todayDay: number; windowFirstDay: number }
): CohortTable {
  const weeks = new Map<number, { signups: number; activated: number; retained: Record<RetentionOffset, number> }>();

  for (const [userId, signupDay] of signups) {
    if (signupDay < windowFirstDay) continue;
    const week = utcWeekStart(signupDay);
    let cohort = weeks.get(week);
    if (!cohort) {
      cohort = { signups: 0, activated: 0, retained: { 1: 0, 7: 0, 30: 0 } };
      weeks.set(week, cohort);
    }
    cohort.signups += 1;
    const activeDays = userDays.get(userId);
    if (activeDays && activeDays.size > 0) cohort.activated += 1;
    for (const offset of RETENTION_OFFSETS) {
      if (activeDays?.has(signupDay + offset)) cohort.retained[offset] += 1;
    }
  }

  const rows = [...weeks]
    .sort(([a], [b]) => a - b)
    .map(([week, cohort]): CohortRow => {
      const retention = { 1: null, 7: null, 30: null } as CohortRow['retention'];
      for (const offset of RETENTION_OFFSETS) {
        if (week + 6 + offset <= todayDay - 1) retention[offset] = (cohort.retained[offset] / cohort.signups) * 100;
      }
      return {
        weekStart: formatUtcDay(week),
        signups: cohort.signups,
        activated: cohort.activated,
        activatedPercent: (cohort.activated / cohort.signups) * 100,
        retention,
      };
    });
  return { rows };
}

// --- Report ---

export interface ExternalActivityReport {
  today: string;
  windowStart: string;
  days: number;
  /** External users with app, CLI or desktop activity: the DAU population. */
  externalUsers: number;
  /** External users with API activity in the window, whether or not they are also in DAU. */
  externalApiUsers: number;
  /** Internal (admin or staff-domain) users with app, CLI or desktop activity in the window. */
  internalUsers: number;
  excluded: Record<ExclusionReason, number>;
  staffExclusionConfigured: boolean;
  dau: DauRow[];
  /** Daily external users with at least one API-sourced action; same span as `dau`. */
  apiUsers: DauRow[];
  /** Daily internal users with app, CLI or desktop activity; same span as `dau`. */
  internal: DauRow[];
  sources: SourceRow[];
  cohorts: CohortTable;
}

export function buildReport(input: {
  /** App, CLI and desktop activity: drives DAU, activation and retention. */
  userDays: UserDayMap;
  /** Public API activity: drives the API users series only. */
  apiUserDays: UserDayMap;
  sourceCounts: UserSourceCounts;
  users: Map<string, UserRecord>;
  rules: ExclusionRules;
  days: number;
  now: Date;
}): ExternalActivityReport {
  const { userDays, apiUserDays, sourceCounts, users, rules, days, now } = input;
  const todayDay = toUtcDay(now);
  const windowStart = windowStartDay(now, days);
  // Exclusions run over every active user so an excluded API-only account is still counted as excluded.
  const { external: externalAny, excluded } = selectExternal(mergeUserDays(userDays, apiUserDays), users, rules);
  const external = restrictUsers(userDays, externalAny);
  const externalApi = restrictUsers(apiUserDays, externalAny);
  const internal = selectInternal(userDays, users, rules);
  const seriesDays = Math.min(DAU_DAYS, days);
  return {
    today: formatUtcDay(todayDay),
    windowStart: formatUtcDay(toUtcDay(windowStart)),
    days,
    externalUsers: external.size,
    externalApiUsers: externalApi.size,
    internalUsers: internal.size,
    excluded,
    staffExclusionConfigured: rules.staffEmail !== null,
    dau: dauSeries(external, todayDay, seriesDays),
    apiUsers: dauSeries(externalApi, todayDay, seriesDays),
    internal: dauSeries(internal, todayDay, seriesDays),
    sources: countRowsBySource(sourceCounts, externalAny),
    cohorts: buildCohorts(external, selectExternalSignups(users, rules), {
      todayDay,
      windowFirstDay: toUtcDay(windowStart),
    }),
  };
}

const pad = (cells: string[], widths: number[]): string =>
  cells
    .map((c, i) => c.padEnd(widths[i]))
    .join('  ')
    .trimEnd();
const COHORT_WIDTHS = [10, 8, 10, 7, 7, 7, 7];
const SERIES_WIDTHS = [10, 5, 9, 8];
const percent = (value: number | null): string => (value === null ? '-' : `${value.toFixed(1)}%`);

export function formatReport(report: ExternalActivityReport): string {
  const { excluded } = report;
  const lines: string[] = [
    `External activity, ${report.windowStart} to ${report.today} UTC (${report.days} days)`,
    `External users with app, CLI or desktop activity: ${report.externalUsers}`,
    `External users with API activity (not in DAU): ${report.externalApiUsers}`,
    `Internal users with app, CLI or desktop activity: ${report.internalUsers}`,
    `Excluded users: ${excluded.admin} admin, ${excluded.staffDomain} staff domain, ` +
      `${excluded.testPattern} test pattern, ${excluded.noUser} no User doc`,
  ];
  if (!report.staffExclusionConfigured) {
    lines.push('WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty, so no staff-domain exclusion was applied.');
  }
  if (report.days > AGENT_EXECUTION_TTL_DAYS) {
    lines.push(
      `Note: AgentExecution rows expire after ${AGENT_EXECUTION_TTL_DAYS} days, so agent activity older ` +
        `than ${AGENT_EXECUTION_TTL_DAYS} days is missing and cohorts before that point are unreliable.`
    );
  }

  lines.push(
    '',
    `DAU (UTC, last ${report.dau.length} days): web app + CLI + desktop. API and Internal users are counted separately.`
  );
  lines.push(pad(['Day', 'DAU', 'API users', 'Internal'], SERIES_WIDTHS));
  report.dau.forEach((row, i) => {
    const apiUsers = report.apiUsers[i]?.users ?? 0;
    const internal = report.internal[i]?.users ?? 0;
    lines.push(
      pad([row.day, String(row.users), String(apiUsers), String(internal)], SERIES_WIDTHS) +
        (row.day === report.today ? '  (partial day)' : '')
    );
  });

  lines.push('', 'UsageEvent rows by source (status ok, external users, whole window)');
  if (report.sources.length === 0) lines.push('(none)');
  const sourceWidth = Math.max(6, ...report.sources.map(s => s.source.length));
  for (const row of report.sources) lines.push(pad([row.source, String(row.rows)], [sourceWidth, 8]));

  lines.push('', 'Weekly signup cohorts (external signups in the window, UTC Sunday start)');
  lines.push(pad(['Cohort', 'Signups', 'Activated', 'Act %', 'D1', 'D7', 'D30'], COHORT_WIDTHS));
  for (const row of report.cohorts.rows) {
    lines.push(
      pad(
        [
          row.weekStart,
          String(row.signups),
          String(row.activated),
          percent(row.activatedPercent),
          percent(row.retention[1]),
          percent(row.retention[7]),
          percent(row.retention[30]),
        ],
        COHORT_WIDTHS
      )
    );
  }
  return lines.join('\n');
}
