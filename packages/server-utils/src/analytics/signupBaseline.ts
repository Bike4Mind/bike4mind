import {
  AuthEvents,
  UiNavigationEvents,
  ModalEvents,
  FileEvents,
  AppFileEvents,
  SessionEvents,
  AiEvents,
  MiscEvents,
} from '@bike4mind/common';
import { z } from 'zod';
import {
  buildExclusionRules,
  DEFAULT_TEST_PATTERN,
  exclusionReason,
  toUtcDay,
  type UserDayMap,
  type UserRecord,
} from './externalActiveUsers';

export const DAY_MS = 86_400_000;
export const baselineWindowSchema = z
  .object({
    since: z.date(),
    until: z.date(),
  })
  .refine(window => window.since < window.until, 'since must be before until');
export type BaselineWindow = z.infer<typeof baselineWindowSchema>;
export type SignupAccount = UserRecord & { id: string; createdAt: Date; signupMethod?: string | null };
export type CensusEvent = {
  at: Date;
  kind: string;
  sessionId?: string;
  credits?: number;
  outcome?: 'failed' | 'recorded';
};
export type SignupEvidence = {
  userDays: UserDayMap;
  events: Map<string, CensusEvent[]>;
  firstSessions: Map<string, { id: string; at: Date }>;
};

export const CENSUS_PRODUCT_EVENTS = [
  ...Object.values(AuthEvents),
  ...Object.values(UiNavigationEvents),
  ...Object.values(ModalEvents),
  ...Object.values(FileEvents),
  ...Object.values(AppFileEvents),
  ...Object.values(SessionEvents),
  ...Object.values(AiEvents),
  ...Object.values(MiscEvents),
] as const;

export function baselineRules(staffDomains: string | undefined, testPattern = DEFAULT_TEST_PATTERN) {
  const rules = buildExclusionRules(staffDomains, new RegExp(testPattern || DEFAULT_TEST_PATTERN, 'i'));
  if (!rules.staffEmail) throw new Error('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is required for a baseline report');
  return rules;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Counts and Wilson 95% intervals keep small cohorts and empty denominators visible. */
export function proportion(count: number, total: number) {
  if (total === 0) return { count, total, percent: null, wilson95: null };
  const probability = count / total;
  const squaredZ = 1.96 ** 2;
  const denominator = 1 + squaredZ / total;
  const center = (probability + squaredZ / (2 * total)) / denominator;
  const margin = (1.96 * Math.sqrt((probability * (1 - probability) + squaredZ / (4 * total)) / total)) / denominator;
  return {
    count,
    total,
    percent: round(probability * 100),
    wilson95: [round(Math.max(0, center - margin) * 100), round(Math.min(1, center + margin) * 100)],
  };
}

function accountCensus(account: SignupAccount, evidence: SignupEvidence, until: Date) {
  const firstSession = evidence.firstSessions.get(account.id);
  const events = (evidence.events.get(account.id) ?? [])
    .filter(event => event.at >= account.createdAt && event.at < until)
    .sort((left, right) => left.at.getTime() - right.at.getTime() || left.kind.localeCompare(right.kind));
  const firstMessage = events.find(event => event.kind === 'message_sent');
  const firstDayEnd = account.createdAt.getTime() + DAY_MS;
  const grants = events.filter(event => event.kind === 'signup_credit_grant' && event.at.getTime() < firstDayEnd);
  const mature = toUtcDay(until) > toUtcDay(account.createdAt) + 7;
  const activeDays = evidence.userDays.get(account.id);
  const day7Plus =
    mature && [...(activeDays ?? [])].some(day => day >= toUtcDay(account.createdAt) + 7 && day < toUtcDay(until));
  // Account-level product events have no reliable session id. Keep their bounded observation
  // window explicit rather than presenting a later login as part of the first notebook.
  const timelineEnd = Math.min(firstDayEnd, until.getTime());
  return {
    userId: account.id,
    signupAt: account.createdAt.toISOString(),
    signupPath: account.signupMethod || 'unknown',
    firstMessageAt: firstMessage?.at.toISOString() ?? null,
    firstSession: firstSession ? { id: firstSession.id, at: firstSession.at.toISOString() } : null,
    firstSessionSent: Boolean(
      firstSession &&
      events.some(
        event =>
          event.kind === 'message_sent' && event.sessionId === firstSession.id && event.at.getTime() < firstDayEnd
      )
    ),
    day7Plus: mature ? day7Plus : null,
    // Historical balances were not snapshotted. A missing grant is unknown, never a zero balance.
    startingBalance: null,
    recordedSignupGrantCredits: grants.length ? grants.reduce((total, event) => total + (event.credits ?? 0), 0) : null,
    timelineWindow: {
      from: account.createdAt.toISOString(),
      until: new Date(timelineEnd).toISOString(),
      complete: until.getTime() >= firstDayEnd,
    },
    timeline: [
      { at: account.createdAt.toISOString(), kind: 'account_created' },
      ...events
        .filter(event => event.at.getTime() < timelineEnd)
        .map(event => ({ ...event, at: event.at.toISOString() })),
    ],
  };
}

export function buildSignupBaseline(input: {
  accounts: SignupAccount[];
  evidence: SignupEvidence;
  window: BaselineWindow;
  staffDomains: string | undefined;
  testPattern?: string;
  trailing90DaySignups: number;
}) {
  const window = baselineWindowSchema.parse(input.window);
  const rules = baselineRules(input.staffDomains, input.testPattern);
  const excluded: Record<string, number> = {};
  const accounts = input.accounts.filter(account => {
    const reason = exclusionReason(account, rules);
    if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    return !reason && account.createdAt >= window.since && account.createdAt < window.until;
  });
  const census = accounts.map(account => accountCensus(account, input.evidence, window.until));
  const summarize = (rows: typeof census) => {
    const mature = rows.filter(row => row.day7Plus !== null);
    const grants = new Map<string, number>();
    for (const row of rows) {
      const amount = row.recordedSignupGrantCredits === null ? 'unknown' : String(row.recordedSignupGrantCredits);
      grants.set(amount, (grants.get(amount) ?? 0) + 1);
    }
    return {
      signups: rows.length,
      sentFirstMessage: proportion(rows.filter(row => row.firstMessageAt !== null).length, rows.length),
      firstSessionSent: proportion(rows.filter(row => row.firstSessionSent).length, rows.length),
      day7PlusActive: proportion(mature.filter(row => row.day7Plus).length, mature.length),
      day7PlusImmature: rows.length - mature.length,
      startingBalanceUnknown: rows.length,
      recordedSignupGrantCredits: Object.fromEntries([...grants].sort(([left], [right]) => left.localeCompare(right))),
    };
  };
  return {
    schemaVersion: 1,
    window: { since: window.since.toISOString(), until: window.until.toISOString() },
    exclusionPolicy: { staffDomainsConfigured: true, testPattern: input.testPattern || DEFAULT_TEST_PATTERN, excluded },
    total: summarize(census),
    bySignupPath: [...new Set(census.map(row => row.signupPath))]
      .sort()
      .map(signupPath => ({ signupPath, ...summarize(census.filter(row => row.signupPath === signupPath)) })),
    trailing90Days: {
      signups: input.trailing90DaySignups,
      standingTestThresholdReached: input.trailing90DaySignups >= 300,
      holdoutThresholdReached: input.trailing90DaySignups >= 1000,
    },
    caveats: [
      'Descriptive counts only: cohort mix, signup-path mix, concurrent changes and regression after bursts can change rates.',
      'Use an explicit post-fix since date for baseline comparisons; a rolling historical cohort is not a post-fix baseline.',
      'D7+ means app activity on or after UTC signup day + 7, through the last complete UTC day; young accounts are outside its denominator.',
      'Activity uses successful UsageEvents, original sent turns (including errors) and non-API AgentExecutions. Public chat API and historical source classification gaps match the external activity report.',
      'Starting balances were not snapshotted and remain unknown. Recorded signup grants in the first 24 hours are evidence of credits granted, not proof of a historical balance. Missing grants are unknown, not zero.',
      'Census product events cover the first 24 hours after signup. First session means the earliest retained non-API, non-cloned notebook; first-session send is a message in it within those 24 hours.',
      'Emails are read only to apply exclusions and never emitted. Prompt/reply content, event metadata and notebook titles are never read or emitted. Missing telemetry, deleted data and AgentExecution TTL can leave gaps.',
      'Signup path is acquisition.signupMethod; accounts without a consented acquisition record remain unknown.',
      'FlowProgress is not yet persisted by the application; no progress-state history is available.',
    ],
    census,
  };
}
export type SignupBaselineReport = ReturnType<typeof buildSignupBaseline>;
