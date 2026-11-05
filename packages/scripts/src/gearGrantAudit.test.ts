import { describe, it, expect } from 'vitest';
import { DEFAULT_TEST_PATTERN, buildExclusionRules } from './externalActiveUsers';
import {
  activeGearKeys,
  buildGearGrantReport,
  formatGearGrantReport,
  gearKeyOf,
  modelTier,
  parseGearAuditArgs,
  percentile,
  type AuditUser,
  type GearGrantAuditInput,
} from './gearGrantAudit';

const NOW = new Date('2026-11-01T00:00:00Z');
const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const tx = (userId: string, key: string) => `gear-unlock:${userId}:${key}`;
const rules = buildExclusionRules('staff.example.com', new RegExp(DEFAULT_TEST_PATTERN, 'i'));

const user = (overrides: Partial<AuditUser> = {}): AuditUser => ({
  email: 'someone@example.org',
  createdAt: daysBefore(20),
  emailVerified: true,
  emailVerifiedAt: null,
  ...overrides,
});

const input = (overrides: Partial<GearGrantAuditInput> = {}): GearGrantAuditInput => ({
  now: NOW,
  days: 30,
  withinMinutes: 60,
  top: 10,
  payouts: [],
  held: [],
  usage: [],
  users: new Map(),
  rules,
  activeGearKeys: ['projects', 'published'],
  freeTierModels: new Set(['small-model']),
  minAccountAgeDays: 7,
  externallyViewedPublishers: new Set(),
  ...overrides,
});

describe('parseGearAuditArgs', () => {
  it('applies the defaults', () => {
    const args = parseGearAuditArgs([]);
    expect(args).toMatchObject({ help: false, days: 30, withinMinutes: 60, top: 10, out: undefined });
    expect(args.testPattern.test('a+e2e@example.org')).toBe(true);
  });

  it('reads every flag', () => {
    const args = parseGearAuditArgs([
      '--days=7',
      '--within-minutes',
      '15',
      '--top',
      '3',
      '--test-pattern',
      'qa',
      '--out',
      'r.md',
      '-h',
    ]);
    expect(args).toMatchObject({ help: true, days: 7, withinMinutes: 15, top: 3, out: 'r.md' });
    expect(args.testPattern.test('QA@x')).toBe(true);
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseGearAuditArgs(['--days', '0'])).toThrow('--days needs a positive integer');
    expect(() => parseGearAuditArgs(['--top', 'x'])).toThrow('--top needs a positive integer');
    expect(() => parseGearAuditArgs(['--test-pattern', '('])).toThrow('not a valid regex');
    expect(() => parseGearAuditArgs(['--apply'])).toThrow();
  });
});

describe('helpers', () => {
  it('reads the gear key off a transaction id', () => {
    expect(gearKeyOf(tx('u1', 'projects'))).toBe('projects');
  });

  it('drops disabled and zero-credit gears only', () => {
    expect(
      activeGearKeys(
        ['a', 'b', 'c', 'd'],
        [
          { key: 'a', enabled: false },
          { key: 'b', credits: 0 },
          { key: 'c', enabled: true, credits: 5 },
        ]
      )
    ).toEqual(['c', 'd']);
  });

  it('tiers models by the free-tier allowlist', () => {
    const allow = new Set(['small']);
    expect(modelTier('small', allow)).toBe('standard');
    expect(modelTier('big', allow)).toBe('frontier');
    expect(modelTier(null, allow)).toBe('unknown');
  });

  it('takes the nearest-rank percentile', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
});

describe('buildGearGrantReport', () => {
  it('reports zeros and n/a on empty data', () => {
    const report = buildGearGrantReport(input());
    expect(report.payouts).toEqual({ count: 0, credits: 0, accounts: 0 });
    expect(report.perGear.map(g => g.credits)).toEqual([0, 0]);
    expect(report.perAccount).toEqual({ mean: null, median: null, p90: null, max: null });
    expect(report.spend.frontierShare).toBeNull();
    expect(report.fastClaims).toEqual({
      activeGears: 2,
      externalSignups: 0,
      claimedEveryGear: 0,
      claimedEveryGearWithin: 0,
    });
    expect(report.staffExclusionConfigured).toBe(true);
    const markdown = formatGearGrantReport(report);
    expect(markdown).toContain('Frontier share: n/a');
    expect(markdown).toContain('mean n/a');
    expect(markdown).not.toContain('WARNING');
  });

  it('excludes internal, test and unknown accounts from every figure', () => {
    const users = new Map<string, AuditUser>([
      ['ext', user()],
      ['admin', user({ isAdmin: true })],
      ['staff', user({ email: 'a@staff.example.com' })],
      ['test', user({ email: 'b+e2e@example.org' })],
    ]);
    const payouts = ['ext', 'admin', 'staff', 'test', 'ghost'].map(id => ({
      transactionId: tx(id, 'projects'),
      userId: id,
      credits: 1000,
      paidAt: daysBefore(1),
    }));
    const held = [
      { transactionId: tx('admin', 'published'), userId: 'admin', status: 'void' as const, heldAt: daysBefore(2) },
    ];
    const usage = [{ userId: 'admin', model: 'big', credits: 50, at: NOW }];
    const report = buildGearGrantReport(input({ users, payouts, held, usage }));
    expect(report.excludedPayouts).toBe(4);
    expect(report.payouts).toEqual({ count: 1, credits: 1000, accounts: 1 });
    expect(report.topAccounts).toEqual([{ userId: 'ext', gears: 1, credits: 1000 }]);
    expect(report.checks.heldByStatus.void).toBe(0);
    expect(report.spend.spentAfterFirstPayout).toBe(0);
  });

  it('aggregates per gear and per account, keeping a gear that is no longer active', () => {
    const users = new Map<string, AuditUser>([
      ['u1', user()],
      ['u2', user()],
    ]);
    const payouts = [
      { transactionId: tx('u1', 'projects'), userId: 'u1', credits: 1000, paidAt: daysBefore(3) },
      { transactionId: tx('u1', 'retired'), userId: 'u1', credits: 500, paidAt: daysBefore(3) },
      { transactionId: tx('u2', 'projects'), userId: 'u2', credits: 1000, paidAt: daysBefore(3) },
    ];
    const report = buildGearGrantReport(input({ users, payouts, top: 1 }));
    expect(report.perGear).toEqual([
      { key: 'projects', payouts: 2, accounts: 2, credits: 2000 },
      { key: 'retired', payouts: 1, accounts: 1, credits: 500 },
      { key: 'published', payouts: 0, accounts: 0, credits: 0 },
    ]);
    expect(report.perAccount).toEqual({ mean: 1250, median: 1000, p90: 1500, max: 1500 });
    expect(report.topAccounts).toEqual([{ userId: 'u1', gears: 2, credits: 1500 }]);
  });

  it('sorts tied accounts and models by id', () => {
    const users = new Map<string, AuditUser>([
      ['b', user()],
      ['a', user()],
    ]);
    const payouts = ['b', 'a'].map(id => ({
      transactionId: tx(id, 'projects'),
      userId: id,
      credits: 100,
      paidAt: daysBefore(3),
    }));
    const usage = [
      { userId: 'a', model: 'zeta', credits: 10, at: daysBefore(2) },
      { userId: 'b', model: 'alpha', credits: 10, at: daysBefore(2) },
    ];
    const report = buildGearGrantReport(input({ users, payouts, usage }));
    expect(report.topAccounts.map(a => a.userId)).toEqual(['a', 'b']);
    expect(report.spend.topModels.map(m => m.model)).toEqual(['alpha', 'zeta']);
  });

  describe('every gear soon after signup', () => {
    const signup = daysBefore(5);
    const claimAll = (userId: string, minutes: number[]) =>
      ['projects', 'published'].map((key, i) => ({
        transactionId: tx(userId, key),
        userId,
        credits: 100,
        paidAt: minutesAfter(signup, minutes[i]),
      }));

    it('counts an account that claimed every gear in time, apart from a late or partial one', () => {
      const users = new Map<string, AuditUser>([
        ['fast', user({ createdAt: signup })],
        ['late', user({ createdAt: signup })],
        ['partial', user({ createdAt: signup })],
        ['none', user({ createdAt: signup })],
        ['old', user({ createdAt: daysBefore(40) })],
        ['nodate', user({ createdAt: null })],
        ['staff', user({ createdAt: signup, email: 'x@staff.example.com' })],
      ]);
      const payouts = [
        ...claimAll('fast', [5, 60]),
        ...claimAll('late', [5, 61]),
        ...claimAll('partial', [5, 6]).slice(0, 1),
        ...claimAll('old', [5, 6]),
        ...claimAll('staff', [5, 6]),
      ];
      const report = buildGearGrantReport(input({ users, payouts }));
      expect(report.fastClaims).toEqual({
        activeGears: 2,
        externalSignups: 4,
        claimedEveryGear: 2,
        claimedEveryGearWithin: 1,
      });
    });

    it('times a queued claim by its queue entry and ignores refused queue entries', () => {
      const users = new Map<string, AuditUser>([
        ['queued', user({ createdAt: signup })],
        ['refused', user({ createdAt: signup })],
      ]);
      const payouts = [
        { transactionId: tx('queued', 'projects'), userId: 'queued', credits: 100, paidAt: minutesAfter(signup, 10) },
        // Paid on release long after it was claimed.
        { transactionId: tx('queued', 'published'), userId: 'queued', credits: 100, paidAt: minutesAfter(signup, 600) },
        { transactionId: tx('refused', 'projects'), userId: 'refused', credits: 100, paidAt: minutesAfter(signup, 10) },
      ];
      const held = [
        {
          transactionId: tx('queued', 'published'),
          userId: 'queued',
          status: 'paid' as const,
          heldAt: minutesAfter(signup, 20),
        },
        // A later queue entry than its payout leaves the payout time in place.
        {
          transactionId: tx('queued', 'projects'),
          userId: 'queued',
          status: 'held' as const,
          heldAt: minutesAfter(signup, 30),
        },
        {
          transactionId: tx('refused', 'published'),
          userId: 'refused',
          status: 'void' as const,
          heldAt: minutesAfter(signup, 11),
        },
      ];
      const report = buildGearGrantReport(input({ users, payouts, held }));
      expect(report.fastClaims.claimedEveryGearWithin).toBe(1);
      expect(report.fastClaims.claimedEveryGear).toBe(1);
    });

    it('counts a claim still waiting in the queue', () => {
      const users = new Map<string, AuditUser>([['waiting', user({ createdAt: signup })]]);
      const payouts = [
        { transactionId: tx('waiting', 'projects'), userId: 'waiting', credits: 100, paidAt: minutesAfter(signup, 10) },
      ];
      const held = [
        {
          transactionId: tx('waiting', 'published'),
          userId: 'waiting',
          status: 'held' as const,
          heldAt: minutesAfter(signup, 20),
        },
      ];
      const report = buildGearGrantReport(input({ users, payouts, held }));
      expect(report.fastClaims.claimedEveryGearWithin).toBe(1);
      expect(report.checks.heldByStatus.held).toBe(1);
    });

    it('counts nobody when no gear is active', () => {
      const users = new Map<string, AuditUser>([['fast', user({ createdAt: signup })]]);
      const report = buildGearGrantReport(input({ users, payouts: claimAll('fast', [1, 2]), activeGearKeys: [] }));
      expect(report.fastClaims).toEqual({
        activeGears: 0,
        externalSignups: 1,
        claimedEveryGear: 0,
        claimedEveryGearWithin: 0,
      });
    });
  });

  describe('frontier spend', () => {
    const users = new Map<string, AuditUser>([['u', user()]]);

    it('draws usage on gear credits first and splits it by tier', () => {
      const payouts = [
        { transactionId: tx('u', 'projects'), userId: 'u', credits: 100, paidAt: daysBefore(10) },
        { transactionId: tx('u', 'published'), userId: 'u', credits: 50, paidAt: daysBefore(5) },
      ];
      const usage = [
        // Before the first payout: not counted at all.
        { userId: 'u', model: 'big', credits: 999, at: daysBefore(12) },
        { userId: 'u', model: 'big', credits: 60, at: daysBefore(9) },
        { userId: 'u', model: 'small-model', credits: 30, at: daysBefore(8) },
        { userId: 'u', model: null, credits: 20, at: daysBefore(7) },
        // The first 100 is spent; 10 of this draws nothing.
        { userId: 'u', model: 'big', credits: 10, at: daysBefore(6) },
        // A payout and usage at the same instant: the payout lands first.
        { userId: 'u', model: 'big', credits: 70, at: daysBefore(5) },
      ];
      const report = buildGearGrantReport(input({ users, payouts, usage }));
      expect(report.spend).toMatchObject({
        gearCredits: 150,
        spentAfterFirstPayout: 190,
        gearAttributed: 150,
        gearAttributedFrontier: 110,
        gearAttributedUnknown: 10,
      });
      expect(report.spend.frontierShare).toBeCloseTo(110 / 150);
      expect(report.spend.topModels).toEqual([
        { model: 'big', tier: 'frontier', credits: 110 },
        { model: 'small-model', tier: 'standard', credits: 30 },
        { model: '(no model)', tier: 'unknown', credits: 10 },
      ]);
    });

    it('leaves the share undefined when no gear credits were spent', () => {
      const payouts = [{ transactionId: tx('u', 'projects'), userId: 'u', credits: 100, paidAt: daysBefore(3) }];
      const report = buildGearGrantReport(input({ users, payouts }));
      expect(report.spend.gearAttributed).toBe(0);
      expect(report.spend.frontierShare).toBeNull();
    });
  });

  describe('claim checks', () => {
    it('measures each payout against the claim conditions', () => {
      const users = new Map<string, AuditUser>([
        ['ok', user({ createdAt: daysBefore(20), emailVerifiedAt: daysBefore(19) })],
        ['young', user({ createdAt: daysBefore(3) })],
        ['nodate', user({ createdAt: null })],
        ['unverified', user({ emailVerified: false })],
        ['verifiedLater', user({ emailVerifiedAt: daysBefore(0.5) })],
      ]);
      const payouts = [...users.keys()].map(id => ({
        transactionId: tx(id, 'projects'),
        userId: id,
        credits: 100,
        paidAt: daysBefore(1),
      }));
      payouts.push(
        { transactionId: tx('ok', 'published'), userId: 'ok', credits: 5000, paidAt: daysBefore(1) },
        { transactionId: tx('young', 'published'), userId: 'young', credits: 5000, paidAt: daysBefore(1) }
      );
      const held = [
        { transactionId: tx('ok', 'old'), userId: 'ok', status: 'paused' as const, heldAt: daysBefore(60) },
        { transactionId: tx('ok', 'vd'), userId: 'ok', status: 'void' as const, heldAt: daysBefore(2) },
      ];
      const report = buildGearGrantReport(input({ users, payouts, held, externallyViewedPublishers: new Set(['ok']) }));
      expect(report.checks).toEqual({
        minAccountAgeDays: 7,
        payoutsChecked: 7,
        claimedBelowMinAge: 2,
        signupUnknown: 1,
        claimedBeforeEmailVerified: 2,
        publishedPayouts: 2,
        publishedWithoutExternalView: 1,
        heldByStatus: { held: 0, paid: 0, void: 1, paused: 0 },
      });
    });
  });
});

describe('formatGearGrantReport', () => {
  it('renders every section as markdown, with the staff-domain warning when unset', () => {
    const users = new Map<string, AuditUser>([['u', user()]]);
    const payouts = [{ transactionId: tx('u', 'projects'), userId: 'u', credits: 1234, paidAt: daysBefore(3) }];
    const usage = [{ userId: 'u', model: 'big', credits: 100, at: daysBefore(2) }];
    const report = buildGearGrantReport(
      input({ users, payouts, usage, rules: buildExclusionRules(undefined, new RegExp(DEFAULT_TEST_PATTERN, 'i')) })
    );
    const markdown = formatGearGrantReport(report);
    expect(markdown).toContain('## Gear grant audit');
    expect(markdown).toContain('> WARNING: NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS is empty');
    expect(markdown).toContain('| projects | 1 | 1 | 1,234 |');
    expect(markdown).toContain('| u | 1 | 1,234 |');
    expect(markdown).toContain('Frontier share: 100.0% of 100 spent gear credits');
    expect(markdown).toContain('| big | frontier | 100 |');
    expect(markdown).toContain('### 2. Every gear claimed within 60 minutes of signup');
    expect(markdown).toContain('A declined claim writes no row');
  });
});
