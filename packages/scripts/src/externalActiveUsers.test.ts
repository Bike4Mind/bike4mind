import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DAYS,
  buildCohorts,
  buildExclusionRules,
  buildReport,
  countRowsBySource,
  dauSeries,
  exclusionReason,
  formatReport,
  parseReportArgs,
  recordActivity,
  recordUsageSource,
  selectExternal,
  toUtcDay,
  type UserDayMap,
  type UserSourceCounts,
} from './externalActiveUsers';

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const day = (iso: string) => toUtcDay(at(iso));
const daysOf = (...isos: string[]) => new Set(isos.map(day));

// 2026-10-13 is a Tuesday; the Sundays used below are 08-30, 09-06, 09-13, 09-27, 10-04 and 10-11.
const NOW = at('2026-10-13');
const TODAY = day('2026-10-13');
const WINDOW_START = TODAY - DEFAULT_DAYS + 1; // 2026-06-16

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
  const cohorts = (map: UserDayMap) => buildCohorts(map, { todayDay: TODAY, windowStartDay: WINDOW_START });

  it('computes D1/D7/D30 as the share active exactly N days after the first day', () => {
    const table = cohorts(
      new Map([
        // Week of Sunday 2026-08-30. D1, D7 and D30 all hit.
        ['u1', daysOf('2026-08-31', '2026-09-01', '2026-09-07', '2026-09-30')],
        // D1 only: active a day before and a day after D7 (09-09), but not on it.
        ['u2', daysOf('2026-09-02', '2026-09-03', '2026-09-08', '2026-09-10')],
        // D1 and D7 hit, D30 misses.
        ['u3', daysOf('2026-09-05', '2026-09-06', '2026-09-12')],
      ])
    );

    expect(table.skippedAtWindowStart).toBe(0);
    expect(table.rows).toHaveLength(1);
    const [row] = table.rows;
    expect(row.weekStart).toBe('2026-08-30');
    expect(row.users).toBe(3);
    expect(row.retention[1]).toBeCloseTo(100);
    expect(row.retention[7]).toBeCloseTo(66.67, 1);
    expect(row.retention[30]).toBeCloseTo(33.33, 1);
  });

  it('prints null for D-N when the cohort is too young, even if a matching day already has activity', () => {
    const table = cohorts(
      new Map([
        // Week of 2026-10-04: D1 measurable (10-11 <= yesterday), D7 not (10-17), even though u4 is
        // active on 10-12, exactly 7 days after their first day.
        ['u4', daysOf('2026-10-05', '2026-10-06', '2026-10-12')],
        // Week of 2026-10-11: first day yesterday and today, nothing measurable yet.
        ['u5', daysOf('2026-10-12', '2026-10-13')],
        ['u6', daysOf('2026-10-13')],
      ])
    );

    expect(table.rows.map(r => r.weekStart)).toEqual(['2026-10-04', '2026-10-11']);
    expect(table.rows[0].retention[1]).toBeCloseTo(100);
    expect(table.rows[0].retention[7]).toBeNull();
    expect(table.rows[0].retention[30]).toBeNull();
    expect(table.rows[1].users).toBe(2);
    expect(table.rows[1].retention).toEqual({ 1: null, 7: null, 30: null });
  });

  it('measures a cohort once its newest possible member has N full days behind them', () => {
    const table = cohorts(
      new Map([
        // Week of 2026-09-06: 09-06 + 6 + 30 is exactly yesterday (10-12), so D30 is measured.
        ['u7', daysOf('2026-09-08', '2026-10-08')],
        // Week of 2026-09-13: D30 would need 10-19, so it is not.
        ['u8', daysOf('2026-09-14', '2026-10-14')],
      ])
    );

    expect(table.rows[0].weekStart).toBe('2026-09-06');
    expect(table.rows[0].retention[30]).toBeCloseTo(100);
    expect(table.rows[1].weekStart).toBe('2026-09-13');
    expect(table.rows[1].retention[30]).toBeNull();
  });

  it('skips users whose first active day is the window start and keeps those one day later', () => {
    const table = cohorts(
      new Map([
        ['old', new Set([WINDOW_START, WINDOW_START + 1])],
        ['new', new Set([WINDOW_START + 1])],
      ])
    );

    expect(table.skippedAtWindowStart).toBe(1);
    expect(table.rows.reduce((sum, r) => sum + r.users, 0)).toBe(1);
  });
});

describe('parseReportArgs', () => {
  it('defaults to a 120 day window and the e2e/test email pattern', () => {
    const args = parseReportArgs([]);

    expect(args.help).toBe(false);
    expect(args.days).toBe(DEFAULT_DAYS);
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
        sourceCounts: new Map([['u1', new Map([['chat', 2]])]]),
        users: new Map([
          ['u1', { email: 'a@customer.example' }],
          ['u2', { email: 'b@customer.example' }],
        ]),
        rules: buildExclusionRules(staffDomains, /\+test/i),
        days,
        now: NOW,
      })
    );

  it('prints the three sections with - for unmeasurable values and a partial-day marker for today', () => {
    const text = build('staff.example.com');

    expect(text).toContain('DAU (UTC, last 30 days)');
    expect(text).toMatch(/2026-10-13 {2}1 {2}\(partial day\)/);
    expect(text).toMatch(/chat\s+2/);
    expect(text).toMatch(/2026-08-30\s+1\s+100\.0%\s+0\.0%\s+0\.0%/);
    expect(text).toMatch(/2026-10-11\s+1\s+-\s+-\s+-/);
    expect(text).not.toContain('WARNING');
  });

  it('warns when no staff domains are configured and when the window outlives the AgentExecution TTL', () => {
    expect(build(undefined)).toContain('WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty');
    expect(build('staff.example.com')).toContain('AgentExecution rows expire after 90 days');
    expect(build('staff.example.com', 60)).not.toContain('AgentExecution rows expire');
  });
});
