import { describe, expect, it } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import {
  classifyUser,
  parseBackfillArgs,
  planBackfill,
  type PlanContext,
  type StartingGrantUser,
} from './oauthStartingGrantPlan';

const CUTOFF = new Date('2026-10-13T00:00:00Z');

const baseUser = (overrides: Partial<StartingGrantUser> = {}): StartingGrantUser => ({
  id: 'user-1',
  email: 'someone@example.com',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  currentCredits: 0,
  isAdmin: false,
  isSystem: false,
  tags: [],
  authProviders: [{ strategy: 'google' }],
  oauthCredentials: { strategy: 'google' },
  ...overrides,
});

const baseContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  createdBefore: CUTOFF,
  excludedEmailDomains: ['bike4mind.com'],
  ownersWithLedgerActivity: new Set(),
  ...overrides,
});

describe('classifyUser', () => {
  it('selects a pre-cutoff Google signup at 0 with no ledger entry', () => {
    expect(classifyUser(baseUser(), baseContext())).toEqual({ eligible: true });
  });

  it('selects a GitHub signup with no email', () => {
    const user = baseUser({ email: null, authProviders: [{ strategy: 'github' }], oauthCredentials: null });
    expect(classifyUser(user, baseContext())).toEqual({ eligible: true });
  });

  it('selects a legacy account that only carries oauthCredentials', () => {
    const user = baseUser({ authProviders: [], oauthCredentials: { strategy: 'github' } });
    expect(classifyUser(user, baseContext())).toEqual({ eligible: true });
  });

  it('treats a missing balance as 0', () => {
    expect(classifyUser(baseUser({ currentCredits: undefined }), baseContext())).toEqual({ eligible: true });
  });

  it.each<[string, Partial<StartingGrantUser>, Partial<PlanContext>, string]>([
    [
      'enterprise SSO only',
      { authProviders: [{ strategy: 'okta' }], oauthCredentials: null },
      {},
      'not-google-or-github',
    ],
    ['no provider at all', { authProviders: [], oauthCredentials: {} }, {}, 'not-google-or-github'],
    ['created at the cutoff', { createdAt: CUTOFF }, {}, 'created-after-cutoff'],
    ['a system account', { isSystem: true }, {}, 'system-account'],
    ['an admin', { isAdmin: true }, {}, 'admin-account'],
    ['an internal email, any case', { email: 'Dev@Bike4Mind.com' }, {}, 'excluded-email-domain'],
    ['a positive balance', { currentCredits: 500 }, {}, 'nonzero-balance'],
    ['a negative balance', { currentCredits: -5 }, {}, 'nonzero-balance'],
    ['the pending-grant tag', { tags: [PENDING_FREE_CREDITS_TAG] }, {}, 'pending-grant-tag'],
    ['any ledger entry', {}, { ownersWithLedgerActivity: new Set(['user-1']) }, 'has-ledger-activity'],
  ])('skips %s', (_label, userOverrides, contextOverrides, reason) => {
    expect(classifyUser(baseUser(userOverrides), baseContext(contextOverrides))).toEqual({ eligible: false, reason });
  });

  it('does not treat a lookalike domain as internal', () => {
    expect(classifyUser(baseUser({ email: 'a@notbike4mind.com' }), baseContext())).toEqual({ eligible: true });
  });
});

describe('planBackfill', () => {
  it('splits users into eligible and one count per skip reason', () => {
    const plan = planBackfill(
      [baseUser({ id: 'a' }), baseUser({ id: 'b', currentCredits: 10 }), baseUser({ id: 'c', isAdmin: true })],
      baseContext()
    );
    expect(plan.eligible.map(user => user.id)).toEqual(['a']);
    expect(plan.skipped['nonzero-balance']).toBe(1);
    expect(plan.skipped['admin-account']).toBe(1);
    expect(Object.values(plan.skipped).reduce((sum, count) => sum + count, 0)).toBe(2);
  });
});

describe('parseBackfillArgs', () => {
  const cutoffFlag = '--created-before=2026-10-13T09:10:00Z';

  it('defaults to a dry run with the internal domain excluded', () => {
    expect(parseBackfillArgs([cutoffFlag])).toEqual({
      execute: false,
      createdBefore: new Date('2026-10-13T09:10:00Z'),
      expectAmount: null,
      excludedEmailDomains: ['bike4mind.com'],
    });
  });

  it('adds every --exclude-email-domain to the defaults', () => {
    const args = parseBackfillArgs([cutoffFlag, '--exclude-email-domain=a.test', '--exclude-email-domain=b.test']);
    expect(args.excludedEmailDomains).toEqual(['bike4mind.com', 'a.test', 'b.test']);
  });

  it('accepts --execute with an expected amount', () => {
    const args = parseBackfillArgs([cutoffFlag, '--execute', '--expect-amount=10000']);
    expect(args).toMatchObject({ execute: true, expectAmount: 10000 });
  });

  it('requires --created-before', () => {
    expect(() => parseBackfillArgs([])).toThrow(/--created-before/);
  });

  it('rejects an unparseable --created-before', () => {
    expect(() => parseBackfillArgs(['--created-before=soon'])).toThrow(/not a valid date/);
  });

  it('refuses --execute without --expect-amount', () => {
    expect(() => parseBackfillArgs([cutoffFlag, '--execute'])).toThrow(/--expect-amount/);
  });

  it.each(['0', '-1', '1.5', 'ten'])('rejects --expect-amount=%s', value => {
    expect(() => parseBackfillArgs([cutoffFlag, `--expect-amount=${value}`])).toThrow(/positive integer/);
  });
});
