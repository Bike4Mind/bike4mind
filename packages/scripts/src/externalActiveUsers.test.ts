import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DAYS,
  QUEST_COPY_SKEW_MS,
  buildCohorts,
  buildExclusionRules,
  buildReport,
  countRowsBySource,
  dauSeries,
  exclusionReason,
  formatReport,
  isApiSource,
  isOriginalQuest,
  mergeUserDays,
  parseReportArgs,
  recordActivity,
  recordUsageSource,
  selectExternal,
  selectExternalSignups,
  toUtcDay,
  windowStartDay,
  type UserDayMap,
  type UserRecord,
  type UserSourceCounts,
} from './externalActiveUsers';

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const day = (iso: string) => toUtcDay(at(iso));
const daysOf = (...isos: string[]) => new Set(isos.map(day));

// 2026-10-13 is a Tuesday; the Sundays used below are 08-30, 09-06, 09-13, 09-27, 10-04 and 10-11.
const NOW = at('2026-10-13');
const TODAY = day('2026-10-13');
const WINDOW_START = TODAY - DEFAULT_DAYS + 1; // 2026-07-16

describe('recordActivity', () => {
  it('collapses many actions by one user on one UTC day into a single user-day', () => {
    const map: UserDayMap = new Map();
    recordActivity(map, 'u1', new Date('2026-10-10T00:00:00Z'));
    recordActivity(map, 'u1', new Date('2026-10-10T09:30:00Z'));
    recordActivity(map, 'u1', new Date('2026-10-10T23:59:59.999Z'));

    expect(map.get('u1')?.size).toBe(1);
  });

  it('splits a user across UTC midnight and keeps users apart', () => {
    const map: UserDayMap = new Map();
    recordActivity(map, 'u1', new Date('2026-10-10T23:59:59.999Z'));
    recordActivity(map, 'u1', new Date('2026-10-11T00:00:00Z'));
    recordActivity(map, 'u2', new Date('2026-10-10T12:00:00Z'));

    expect(map.get('u1')?.size).toBe(2);
    expect(map.get('u2')?.size).toBe(1);
  });
});

describe('recordUsageSource / countRowsBySource', () => {
  it("keeps missing and empty sources as 'unset' and counts only the given users", () => {
    const counts: UserSourceCounts = new Map();
    recordUsageSource(counts, 'u1', 'chat');
    recordUsageSource(counts, 'u1', 'chat');
    recordUsageSource(counts, 'u1', undefined);
    recordUsageSource(counts, 'u2', '');
    recordUsageSource(counts, 'staff', 'api');

    const external: UserDayMap = new Map([
      ['u1', new Set()],
      ['u2', new Set()],
    ]);

    expect(countRowsBySource(counts, external)).toEqual([
      { source: 'chat', rows: 2 },
      { source: 'unset', rows: 2 },
    ]);
  });
});

describe('exclusions', () => {
  const rules = buildExclusionRules('Staff.Example.com, other.example', /\+(e2e|test)/i);

  it('classifies each exclusion reason, with a missing User doc first', () => {
    expect(exclusionReason(undefined, rules)).toBe('noUser');
    expect(exclusionReason({ email: 'a@customer.example', isAdmin: true }, rules)).toBe('admin');
    expect(exclusionReason({ email: 'dev@STAFF.example.com' }, rules)).toBe('staffDomain');
    expect(exclusionReason({ email: 'qa+E2E@customer.example' }, rules)).toBe('testPattern');
    expect(exclusionReason({ email: 'a@customer.example' }, rules)).toBeNull();
  });

  it('matches staff on the email domain only, not a substring', () => {
    expect(exclusionReason({ email: 'a@staff.example.com.evil.example' }, rules)).toBeNull();
  });

  it('keeps external users that have no email and applies no staff rule when none are configured', () => {
    const noStaff = buildExclusionRules(undefined, /\+test/i);
    expect(exclusionReason({ email: null }, noStaff)).toBeNull();
    expect(exclusionReason({ email: 'dev@staff.example.com' }, noStaff)).toBeNull();
  });

  it('selectExternal drops excluded users and counts them by reason', () => {
    const map: UserDayMap = new Map(['ext', 'adm', 'stf', 'tst', 'ghost'].map(id => [id, daysOf('2026-10-10')]));
    const users = new Map([
      ['ext', { email: 'a@customer.example' }],
      ['adm', { email: 'b@customer.example', isAdmin: true }],
      ['stf', { email: 'c@staff.example.com' }],
      ['tst', { email: 'd+test@customer.example' }],
    ]);

    const { external, excluded } = selectExternal(map, users, rules);

    expect([...external.keys()]).toEqual(['ext']);
    expect(excluded).toEqual({ noUser: 1, admin: 1, staffDomain: 1, testPattern: 1 });
  });

  it('selectExternalSignups maps external users with a createdAt to their UTC signup day, active or not', () => {
    const created = at('2026-09-02');
    const users = new Map([
      ['ext', { email: 'a@customer.example', createdAt: created }],
      ['late', { email: 'l@customer.example', createdAt: new Date('2026-09-02T23:59:59.999Z') }],
      ['undated', { email: 'u@customer.example' }],
      ['adm', { email: 'b@customer.example', isAdmin: true, createdAt: created }],
      ['stf', { email: 'c@staff.example.com', createdAt: created }],
      ['tst', { email: 'd+test@customer.example', createdAt: created }],
    ]);

    expect(selectExternalSignups(users, rules)).toEqual(
      new Map([
        ['ext', day('2026-09-02')],
        ['late', day('2026-09-02')],
      ])
    );
  });
});

describe('windowStartDay', () => {
  it('is UTC midnight of the first day of a window ending on the UTC day of now', () => {
    expect(windowStartDay(NOW, DEFAULT_DAYS)).toEqual(new Date('2026-07-16T00:00:00Z'));
    expect(toUtcDay(windowStartDay(NOW, DEFAULT_DAYS))).toBe(WINDOW_START);
  });

  it('is the start of today for a one-day window, whatever the time of day', () => {
    expect(windowStartDay(new Date('2026-10-13T23:59:59.999Z'), 1)).toEqual(new Date('2026-10-13T00:00:00Z'));
    expect(windowStartDay(new Date('2026-10-13T00:00:00Z'), 1)).toEqual(new Date('2026-10-13T00:00:00Z'));
  });
});

describe('dauSeries', () => {
  it('counts distinct users per day, fills quiet days with zero and ignores days outside the span', () => {
    const map: UserDayMap = new Map([
      ['u1', daysOf('2026-10-10', '2026-10-12', '2026-09-01')],
      ['u2', daysOf('2026-10-10')],
    ]);

    const series = dauSeries(map, TODAY, 5);

    expect(series).toEqual([
      { day: '2026-10-09', users: 0 },
      { day: '2026-10-10', users: 2 },
      { day: '2026-10-11', users: 0 },
      { day: '2026-10-12', users: 1 },
      { day: '2026-10-13', users: 0 },
    ]);
  });
});

describe('buildCohorts', () => {
  /** userId -> signup UTC day from ISO dates. */
  const signupsOf = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([id, iso]) => [id, day(iso)]));
  const cohorts = (userDays: UserDayMap, signups: Map<string, number>) =>
    buildCohorts(userDays, signups, { todayDay: TODAY, windowFirstDay: WINDOW_START });

  it('computes D1/D7/D30 as the share active exactly N days after the signup day', () => {
    const table = cohorts(
      new Map([
        // Week of Sunday 2026-08-30. D1, D7 and D30 all hit.
        ['u1', daysOf('2026-09-01', '2026-09-07', '2026-09-30')],
        // D1 only: active a day before and a day after D7 (09-09), but not on it.
        ['u2', daysOf('2026-09-03', '2026-09-08', '2026-09-10')],
        // D1 and D7 hit, D30 misses.
        ['u3', daysOf('2026-09-06', '2026-09-12')],
      ]),
      signupsOf({ u1: '2026-08-31', u2: '2026-09-02', u3: '2026-09-05' })
    );

    expect(table.rows).toHaveLength(1);
    const [row] = table.rows;
    expect(row.weekStart).toBe('2026-08-30');
    expect(row.signups).toBe(3);
    expect(row.activated).toBe(3);
    expect(row.activatedPercent).toBeCloseTo(100);
    expect(row.retention[1]).toBeCloseTo(100);
    expect(row.retention[7]).toBeCloseTo(66.67, 1);
    expect(row.retention[30]).toBeCloseTo(33.33, 1);
  });

  it('prints null for D-N when the cohort is too young, even if a matching day already has activity', () => {
    const table = cohorts(
      new Map([
        // Week of 2026-10-04: D1 measurable (10-11 <= yesterday), D7 not (10-17), even though u4 is
        // active on 10-12, exactly 7 days after signing up on 10-05.
        ['u4', daysOf('2026-10-06', '2026-10-12')],
        // Week of 2026-10-11: signed up yesterday and today, nothing measurable yet.
        ['u5', daysOf('2026-10-12', '2026-10-13')],
        ['u6', daysOf('2026-10-13')],
      ]),
      signupsOf({ u4: '2026-10-05', u5: '2026-10-12', u6: '2026-10-13' })
    );

    expect(table.rows.map(r => r.weekStart)).toEqual(['2026-10-04', '2026-10-11']);
    expect(table.rows[0].retention[1]).toBeCloseTo(100);
    expect(table.rows[0].retention[7]).toBeNull();
    expect(table.rows[0].retention[30]).toBeNull();
    expect(table.rows[1].signups).toBe(2);
    expect(table.rows[1].retention).toEqual({ 1: null, 7: null, 30: null });
  });

  it('measures a cohort once its newest possible signup has N full days behind them', () => {
    const table = cohorts(
      new Map([
        // Week of 2026-09-06: 09-06 + 6 + 30 is exactly yesterday (10-12), so D30 is measured.
        ['u7', daysOf('2026-09-08', '2026-10-08')],
        // Week of 2026-09-13: D30 would need 10-19, so it is not.
        ['u8', daysOf('2026-09-14', '2026-10-14')],
      ]),
      signupsOf({ u7: '2026-09-08', u8: '2026-09-14' })
    );

    expect(table.rows[0].weekStart).toBe('2026-09-06');
    expect(table.rows[0].retention[30]).toBeCloseTo(100);
    expect(table.rows[1].weekStart).toBe('2026-09-13');
    expect(table.rows[1].retention[30]).toBeNull();
  });

  it('keeps a signup on the window start day and leaves out one the day before', () => {
    const table = cohorts(
      new Map([
        ['before', new Set([WINDOW_START, WINDOW_START + 1])],
        ['first', new Set([WINDOW_START + 1])],
      ]),
      new Map([
        ['before', WINDOW_START - 1],
        ['first', WINDOW_START],
      ])
    );

    expect(table.rows.reduce((sum, r) => sum + r.signups, 0)).toBe(1);
    expect(table.rows[0].retention[1]).toBeCloseTo(100);
  });

  it('counts a signup with no activity as a signup that did not activate or return', () => {
    const table = cohorts(
      new Map([['active', daysOf('2026-09-02', '2026-09-03')]]),
      signupsOf({ active: '2026-09-02', idle: '2026-09-03' })
    );

    const [row] = table.rows;
    expect(row.signups).toBe(2);
    expect(row.activated).toBe(1);
    expect(row.activatedPercent).toBeCloseTo(50);
    expect(row.retention[1]).toBeCloseTo(50);
    expect(row.retention[7]).toBeCloseTo(0);
  });
});

describe('buildReport cohorts', () => {
  const rules = buildExclusionRules('staff.example.com', /\+test/i);
  const report = (userDays: UserDayMap, users: Map<string, UserRecord>) =>
    buildReport({
      userDays,
      apiUserDays: new Map(),
      sourceCounts: new Map(),
      users,
      rules,
      days: DEFAULT_DAYS,
      now: NOW,
    });

  it('counts a pre-window signup first active mid-window toward DAU but in no cohort', () => {
    const result = report(
      new Map([['old', daysOf('2026-10-10')]]),
      new Map([['old', { email: 'o@customer.example', createdAt: at('2026-01-05') }]])
    );

    expect(result.externalUsers).toBe(1);
    expect(result.dau.find(r => r.day === '2026-10-10')?.users).toBe(1);
    expect(result.cohorts.rows).toEqual([]);
  });

  it('counts an in-window signup with no activity in signups only, with 0% activation and retention', () => {
    const result = report(
      new Map(),
      new Map([
        ['idle', { email: 'i@customer.example', createdAt: at('2026-09-02') }],
        ['staff', { email: 's@staff.example.com', createdAt: at('2026-09-02') }],
      ])
    );

    expect(result.externalUsers).toBe(0);
    expect(result.cohorts.rows).toEqual([
      {
        weekStart: '2026-08-30',
        signups: 1,
        activated: 0,
        activatedPercent: 0,
        retention: { 1: 0, 7: 0, 30: 0 },
      },
    ]);
  });
});

describe('isApiSource', () => {
  it("is true only for 'api': an unset or empty source is app activity", () => {
    expect(isApiSource('api')).toBe(true);
    for (const source of [undefined, null, '', 'web', 'cli', 'chat', 'agent', 'system']) {
      expect(isApiSource(source)).toBe(false);
    }
  });
});

describe('mergeUserDays', () => {
  it('unions the days of a user present in several maps without mutating the inputs', () => {
    const app: UserDayMap = new Map([['u1', daysOf('2026-10-10')]]);
    const api: UserDayMap = new Map([
      ['u1', daysOf('2026-10-11')],
      ['u2', daysOf('2026-10-10')],
    ]);

    const merged = mergeUserDays(app, api);

    expect(merged.get('u1')).toEqual(daysOf('2026-10-10', '2026-10-11'));
    expect(merged.get('u2')).toEqual(daysOf('2026-10-10'));
    expect(app.get('u1')).toEqual(daysOf('2026-10-10'));
  });
});

describe('buildReport API users', () => {
  const rules = buildExclusionRules('staff.example.com', /\+test/i);
  const report = (
    userDays: UserDayMap,
    apiUserDays: UserDayMap,
    users: Map<string, UserRecord>,
    sourceCounts: UserSourceCounts = new Map()
  ) => buildReport({ userDays, apiUserDays, sourceCounts, users, rules, days: DEFAULT_DAYS, now: NOW });
  const usersByDay = (rows: { day: string; users: number }[]) => Object.fromEntries(rows.map(r => [r.day, r.users]));

  it('keeps an API-only user out of DAU and externalUsers but in API users, with their source rows', () => {
    const result = report(
      new Map(),
      new Map([['dev', daysOf('2026-10-10', '2026-10-11')]]),
      new Map([['dev', { email: 'd@customer.example', createdAt: at('2026-01-05') }]]),
      new Map([['dev', new Map([['api', 3]])]])
    );

    expect(result.externalUsers).toBe(0);
    expect(result.externalApiUsers).toBe(1);
    expect(result.dau.every(r => r.users === 0)).toBe(true);
    expect(usersByDay(result.apiUsers)['2026-10-10']).toBe(1);
    expect(usersByDay(result.apiUsers)['2026-10-11']).toBe(1);
    expect(result.sources).toEqual([{ source: 'api', rows: 3 }]);
  });

  it('counts a user with web and API activity on one day once in DAU and once in API users', () => {
    const result = report(
      new Map([['u1', daysOf('2026-10-10', '2026-10-12')]]),
      new Map([['u1', daysOf('2026-10-10', '2026-10-11')]]),
      new Map([['u1', { email: 'a@customer.example', createdAt: at('2026-01-05') }]])
    );

    expect(result.externalUsers).toBe(1);
    expect(result.externalApiUsers).toBe(1);
    expect(usersByDay(result.dau)).toMatchObject({ '2026-10-10': 1, '2026-10-11': 0, '2026-10-12': 1 });
    expect(usersByDay(result.apiUsers)).toMatchObject({ '2026-10-10': 1, '2026-10-11': 1, '2026-10-12': 0 });
  });

  it('does not activate or retain a cohort user on API activity alone', () => {
    const result = report(
      new Map([['app', daysOf('2026-10-11')]]),
      new Map([
        ['app', daysOf('2026-10-11')],
        ['api', daysOf('2026-10-10', '2026-10-11')],
      ]),
      new Map([
        ['app', { email: 'a@customer.example', createdAt: at('2026-10-10') }],
        ['api', { email: 'b@customer.example', createdAt: at('2026-10-10') }],
      ])
    );

    expect(result.cohorts.rows).toEqual([
      expect.objectContaining({
        weekStart: '2026-10-04',
        signups: 2,
        activated: 1,
        retention: { 1: 50, 7: null, 30: null },
      }),
    ]);
  });

  it('still counts an excluded account whose only activity is API, and keeps it out of API users', () => {
    const result = report(
      new Map(),
      new Map([
        ['staff', daysOf('2026-10-10')],
        ['ghost', daysOf('2026-10-10')],
      ]),
      new Map([['staff', { email: 's@staff.example.com', createdAt: at('2026-01-05') }]])
    );

    expect(result.excluded).toEqual({ noUser: 1, admin: 0, staffDomain: 1, testPattern: 0 });
    expect(result.externalApiUsers).toBe(0);
    expect(result.apiUsers.every(r => r.users === 0)).toBe(true);
  });
});

describe('isOriginalQuest', () => {
  const timestamp = new Date('2026-10-10T10:00:00Z');
  const createdAt = (offsetMs: number) => ({ getTimestamp: () => new Date(timestamp.getTime() + offsetMs) });

  it('counts a quest whose _id was created with its timestamp', () => {
    expect(isOriginalQuest(createdAt(0), timestamp)).toBe(true);
    expect(isOriginalQuest(createdAt(5_000), timestamp)).toBe(true);
    expect(isOriginalQuest(createdAt(-5_000), timestamp)).toBe(true);
  });

  it('keeps the boundary at exactly one hour for an _id newer than its timestamp', () => {
    expect(isOriginalQuest(createdAt(QUEST_COPY_SKEW_MS), timestamp)).toBe(true);
    expect(isOriginalQuest(createdAt(QUEST_COPY_SKEW_MS + 1_000), timestamp)).toBe(false);
  });

  it('counts a retry whose timestamp moved hours past its _id', () => {
    expect(isOriginalQuest(createdAt(-QUEST_COPY_SKEW_MS - 1_000), timestamp)).toBe(true);
    expect(isOriginalQuest(createdAt(-5 * QUEST_COPY_SKEW_MS), timestamp)).toBe(true);
  });

  it('drops a copy made 30 days after the source timestamp', () => {
    expect(isOriginalQuest(createdAt(30 * 86_400_000), timestamp)).toBe(false);
  });
});

describe('parseReportArgs', () => {
  it('defaults to a 90 day window and the e2e/test email pattern', () => {
    const args = parseReportArgs([]);

    expect(args.help).toBe(false);
    expect(args.days).toBe(DEFAULT_DAYS);
    expect(args.days).toBe(90);
    expect(args.testPattern.test('qa+E2E@customer.example')).toBe(true);
    expect(args.testPattern.test('qa+test@customer.example')).toBe(true);
    expect(args.testPattern.test('qa@customer.example')).toBe(false);
  });

  it('accepts space and equals forms and compiles the pattern case-insensitively', () => {
    expect(parseReportArgs(['--days', '30']).days).toBe(30);
    const args = parseReportArgs(['--days=45', '--test-pattern=^demo-']);
    expect(args.days).toBe(45);
    expect(args.testPattern.test('DEMO-1@customer.example')).toBe(true);
    expect(parseReportArgs(['--test-pattern', 'x+']).testPattern.source).toBe('x+');
  });

  it('flags --help', () => {
    expect(parseReportArgs(['--help']).help).toBe(true);
  });

  it('rejects bad input instead of running with a surprise value', () => {
    expect(() => parseReportArgs(['--days'])).toThrow('--days needs a value');
    expect(() => parseReportArgs(['--days', '--help'])).toThrow('--days needs a value');
    expect(() => parseReportArgs(['--days', 'abc'])).toThrow('positive integer');
    expect(() => parseReportArgs(['--days', '0'])).toThrow('positive integer');
    expect(() => parseReportArgs(['--test-pattern', '('])).toThrow('not a valid regex');
    expect(() => parseReportArgs(['--day', '5'])).toThrow('Unknown argument');
  });
});

describe('formatReport', () => {
  const build = (staffDomains: string | undefined, days = DEFAULT_DAYS) =>
    formatReport(
      buildReport({
        userDays: new Map([
          ['u1', daysOf('2026-09-01', '2026-09-02', '2026-10-13')],
          ['u2', daysOf('2026-10-12')],
        ]),
        apiUserDays: new Map([['u3', daysOf('2026-10-13')]]),
        sourceCounts: new Map([['u1', new Map([['chat', 2]])]]),
        users: new Map([
          ['u1', { email: 'a@customer.example', createdAt: at('2026-09-01') }],
          ['u2', { email: 'b@customer.example', createdAt: at('2026-10-12') }],
          ['u3', { email: 'c@customer.example', createdAt: at('2026-01-05') }],
        ]),
        rules: buildExclusionRules(staffDomains, /\+test/i),
        days,
        now: NOW,
      })
    );

  it('prints the three sections with - for unmeasurable values and a partial-day marker for today', () => {
    const text = build('staff.example.com');

    expect(text).toContain('DAU (UTC, last 30 days)');
    expect(text).toMatch(/Day\s+DAU\s+API users/);
    expect(text).toMatch(/2026-10-13 {2}1 +1 {2}\(partial day\)/);
    expect(text).toMatch(/2026-10-12 {2}1 +0\n/);
    expect(text).toContain('External users with API activity (not in DAU): 1');
    expect(text).toMatch(/chat\s+2/);
    expect(text).toContain('Weekly signup cohorts');
    expect(text).toMatch(/Cohort\s+Signups\s+Activated\s+Act %\s+D1\s+D7\s+D30/);
    expect(text).toMatch(/2026-08-30\s+1\s+1\s+100\.0%\s+100\.0%\s+0\.0%\s+0\.0%/);
    expect(text).toMatch(/2026-10-11\s+1\s+1\s+100\.0%\s+-\s+-\s+-/);
    expect(text).not.toContain('Skipped');
    expect(text).not.toContain('WARNING');
  });

  it('warns when no staff domains are configured and when the window outlives the AgentExecution TTL', () => {
    expect(build(undefined)).toContain('WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty');
    expect(build('staff.example.com', 120)).toContain(
      'AgentExecution rows expire after 90 days, so agent activity older than 90 days is missing ' +
        'and cohorts before that point are unreliable.'
    );
    expect(build('staff.example.com')).not.toContain('AgentExecution rows expire');
    expect(build('staff.example.com', 60)).not.toContain('AgentExecution rows expire');
  });
});
