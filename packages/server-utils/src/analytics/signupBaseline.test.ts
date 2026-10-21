import { describe, expect, it } from 'vitest';
import {
  baselineRules,
  buildSignupBaseline,
  proportion,
  type SignupAccount,
  type SignupEvidence,
} from './signupBaseline';
import { toUtcDay } from './externalActiveUsers';

const at = (date: string) => new Date(date);
const window = { since: at('2026-10-01T00:00:00Z'), until: at('2026-10-20T00:00:00Z') };
const account = (id: string, extra: Partial<SignupAccount> = {}): SignupAccount => ({
  id,
  email: `${id}@example.org`,
  createdAt: at('2026-10-02T10:00:00Z'),
  signupMethod: 'google',
  ...extra,
});
const evidence = (): SignupEvidence => ({ userDays: new Map(), events: new Map(), firstSessions: new Map() });
const report = (accounts: SignupAccount[], facts = evidence()) =>
  buildSignupBaseline({
    accounts,
    evidence: facts,
    window,
    staffDomains: 'staff.example.org',
    trailing90DaySignups: 300,
  });

describe('signup baseline', () => {
  it('keeps inactive accounts in the signup denominator and excludes internal and test accounts everywhere', () => {
    const result = report([
      account('active'),
      account('inactive'),
      account('staff', { email: 'a@staff.example.org' }),
      account('admin', { isAdmin: true }),
      account('synthetic', { isSynthetic: true }),
      account('test', { email: 'a+test@example.org' }),
    ]);
    expect(result.total.signups).toBe(2);
    expect(result.total.sentFirstMessage).toMatchObject({ count: 0, total: 2 });
    expect(result.census.map(row => row.userId)).toEqual(['active', 'inactive']);
    expect(result.exclusionPolicy.excluded).toEqual({ staffDomain: 1, admin: 1, testPattern: 1, synthetic: 1 });
    expect(result.bySignupPath).toHaveLength(1);
  });

  it('counts D7+ activity after day 7 and removes young accounts from the denominator', () => {
    const facts = evidence();
    facts.userDays.set('returner', new Set([toUtcDay(at('2026-10-11T00:00:00Z'))]));
    facts.userDays.set('young', new Set([toUtcDay(at('2026-10-19T00:00:00Z'))]));
    const result = report(
      [account('returner'), account('inactive'), account('young', { createdAt: at('2026-10-13T00:00:00Z') })],
      facts
    );
    expect(result.total.day7PlusActive).toMatchObject({ count: 1, total: 2, percent: 50 });
    expect(result.total.day7PlusImmature).toBe(1);
  });

  it('matures D7+ only once the UTC day of until is past signup day + 7', () => {
    const facts = evidence();
    const lastCompleteDay = toUtcDay(at('2026-10-19T12:00:00Z'));
    facts.userDays.set('justMature', new Set([lastCompleteDay]));
    facts.userDays.set('justImmature', new Set([lastCompleteDay]));
    const result = report(
      [
        account('justMature', { createdAt: at('2026-10-12T23:59:59Z') }),
        account('justImmature', { createdAt: at('2026-10-13T00:00:00Z') }),
      ],
      facts
    );
    expect(result.census.map(row => [row.userId, row.day7Plus])).toEqual([
      ['justMature', true],
      ['justImmature', null],
    ]);
    expect(result.total.day7PlusActive).toMatchObject({ count: 1, total: 1 });
    expect(result.total.day7PlusImmature).toBe(1);
  });

  it('separates ever sent from first-notebook send and limits timeline to first 24 hours', () => {
    const facts = evidence();
    facts.firstSessions.set('u', { id: 'first', at: at('2026-10-02T10:01:00Z') });
    facts.events.set('u', [
      { kind: 'message_sent', at: at('2026-10-04T10:00:00Z'), sessionId: 'first' },
      { kind: 'message_sent', at: at('2026-10-02T11:00:00Z'), sessionId: 'second' },
      { kind: 'User Login', at: at('2026-10-02T10:00:01Z') },
      { kind: 'signup_credit_grant', at: at('2026-10-02T10:00:02Z'), credits: 100 },
      { kind: 'signup_credit_grant', at: at('2026-10-15T00:00:00Z'), credits: 10000 },
    ]);
    const result = report([account('u')], facts);
    expect(result.total.sentFirstMessage.count).toBe(1);
    expect(result.total.firstSessionSent.count).toBe(0);
    expect(result.census[0].timeline.map(event => event.kind)).toEqual([
      'account_created',
      'User Login',
      'signup_credit_grant',
      'message_sent',
    ]);
    expect(result.census[0].recordedSignupGrantCredits).toBe(100);
    expect(result.census[0].startingBalance).toBeNull();
  });

  it('never turns missing grant evidence into a zero starting balance', () => {
    const result = report([account('u')]);
    expect(result.bySignupPath[0].recordedSignupGrantCredits).toEqual({ unknown: 1 });
    expect(result.total.startingBalanceUnknown).toBe(1);
    expect(result.trailing90Days).toEqual({
      signups: 300,
      standingTestThresholdReached: true,
      holdoutThresholdReached: false,
    });
  });

  it('honors half-open windows and exposes incomplete first days', () => {
    const result = report([
      account('before', { createdAt: at('2026-09-30T23:59:59Z') }),
      account('atEnd', { createdAt: window.until }),
      account('partial', { createdAt: at('2026-10-19T23:00:00Z') }),
    ]);
    expect(result.total.signups).toBe(1);
    expect(result.census[0].timelineWindow.complete).toBe(false);
    expect(result.total.day7PlusActive.percent).toBeNull();
  });

  it('fails on absent staff exclusions or reversed dates and validates regexes', () => {
    expect(baselineRules('staff.example.org').testEmail.test('browser-e2e@test.com')).toBe(true);
    expect(() => baselineRules('')).toThrow('INTERNAL_STAFF_DOMAINS');
    expect(() => baselineRules('staff.example.org', '[')).toThrow();
    expect(baselineRules('staff.example.org', '').testEmail.test('normal@example.org')).toBe(false);
    expect(() =>
      buildSignupBaseline({
        accounts: [],
        evidence: evidence(),
        window: { since: window.until, until: window.since },
        staffDomains: 'staff.example.org',
        trailing90DaySignups: 0,
      })
    ).toThrow();
  });

  it('reports bounded confidence intervals for small and empty samples', () => {
    expect(proportion(0, 0).wilson95).toBeNull();
    expect(proportion(0, 5).wilson95).toEqual([0, 43.45]);
    expect(proportion(5, 5).wilson95).toEqual([56.55, 100]);
  });
});
