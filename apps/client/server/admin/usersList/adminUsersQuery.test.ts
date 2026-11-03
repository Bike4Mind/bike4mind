import { describe, expect, it } from 'vitest';
import { AdminUsersQuerySchema } from '@client/app/utils/adminUsersFilter';
import {
  adminUsersSort,
  buildAdminUsersMatch,
  organizationNamesOf,
  type AdminUsersQueryContext,
} from './adminUsersQuery';

const now = new Date('2026-10-27T12:00:00.000Z');
const context: AdminUsersQueryContext = {
  now,
  organizationIds: ['org-1'],
  toObjectId: id => ({ objectId: id }),
};

const conditionsOf = (match: Record<string, unknown>) => (match.$and ?? []) as Record<string, unknown>[];

describe('buildAdminUsersMatch', () => {
  it('matches everyone for an empty filter', () => {
    expect(buildAdminUsersMatch({}, context)).toEqual({});
  });

  it('searches name, username and email, and the id when the term is one', () => {
    const [byText] = conditionsOf(buildAdminUsersMatch({ search: 'a.b' }, context));
    expect(byText).toEqual({
      $or: [
        { name: { $regex: 'a\\.b', $options: 'i' } },
        { username: { $regex: 'a\\.b', $options: 'i' } },
        { email: { $regex: 'a\\.b', $options: 'i' } },
      ],
    });

    const id = '0123456789abcdef01234567';
    const [byId] = conditionsOf(buildAdminUsersMatch({ search: id }, context));
    expect((byId.$or as unknown[]).at(-1)).toEqual({ _id: { objectId: id } });
  });

  it('reads the Admin tag as the isAdmin flag', () => {
    expect(conditionsOf(buildAdminUsersMatch({ tags: ['Admin'] }, context))).toEqual([{ isAdmin: true }]);
    expect(conditionsOf(buildAdminUsersMatch({ tags: ['Admin', 'beta'] }, context))).toEqual([
      { $or: [{ isAdmin: true }, { tags: { $in: ['beta'] } }] },
    ]);
  });

  it('narrows by organization ids, plus unassigned users when asked', () => {
    expect(conditionsOf(buildAdminUsersMatch({ orgSearch: ['Acme', 'Unassigned'] }, context))).toEqual([
      { $or: [{ organizationId: { $in: ['org-1'] } }, { organizationId: null }] },
    ]);
    expect(buildAdminUsersMatch({ orgSearch: ['all'] }, context)).toEqual({});
  });

  it.each([
    ['active', { isBanned: { $ne: true }, isModerated: { $ne: true } }],
    ['suspended', { isBanned: true }],
    ['restricted', { isModerated: true, isBanned: { $ne: true } }],
  ] as const)('maps status %s', (status, expected) => {
    expect(conditionsOf(buildAdminUsersMatch({ status }, context))).toEqual([expected]);
  });

  it('matches an email domain and its subdomains but not a lookalike', () => {
    const [condition] = conditionsOf(buildAdminUsersMatch({ emailDomain: 'example.com' }, context));
    const { $regex, $options } = condition.email as { $regex: string; $options: string };
    const pattern = new RegExp($regex, $options);
    expect(pattern.test('bot@example.com')).toBe(true);
    expect(pattern.test('bot@mail.EXAMPLE.com')).toBe(true);
    expect(pattern.test('bot@notexample.com')).toBe(false);
    expect(pattern.test('bot@example.com.evil')).toBe(false);
  });

  it('treats email signup as no identity provider', () => {
    expect(conditionsOf(buildAdminUsersMatch({ signupMethod: 'email' }, context))).toEqual([
      { $or: [{ authProviders: { $exists: false } }, { authProviders: { $size: 0 } }] },
    ]);
    expect(conditionsOf(buildAdminUsersMatch({ signupMethod: 'github' }, context))).toEqual([
      { 'authProviders.strategy': 'github' },
    ]);
  });

  it('maps plan, verified, signed-up window and risk band', () => {
    expect(
      conditionsOf(buildAdminUsersMatch({ plan: 'PaidUser', verified: 'no', signedUp: 'hour', risk: 'high' }, context))
    ).toEqual([
      { level: 'PaidUser' },
      { emailVerified: { $ne: true } },
      { createdAt: { $gte: new Date('2026-10-27T11:00:00.000Z') } },
      { 'signupGrantAssessment.band': 'review' },
    ]);
  });

  it('maps the signup chart window, end exclusive, alongside a signed-up window', () => {
    expect(
      conditionsOf(
        buildAdminUsersMatch(
          { signedUp: 'hour', createdFrom: '2026-10-27T10:00:00.000Z', createdTo: '2026-10-27T11:00:00.000Z' },
          context
        )
      )
    ).toEqual([
      { createdAt: { $gte: new Date('2026-10-27T11:00:00.000Z') } },
      { createdAt: { $gte: new Date('2026-10-27T10:00:00.000Z'), $lt: new Date('2026-10-27T11:00:00.000Z') } },
    ]);
    expect(conditionsOf(buildAdminUsersMatch({ createdTo: '2026-10-27T11:00:00.000Z' }, context))).toEqual([
      { createdAt: { $lt: new Date('2026-10-27T11:00:00.000Z') } },
    ]);
  });
});

describe('organizationNamesOf', () => {
  it('returns null when the filter does not narrow by organization', () => {
    expect(organizationNamesOf({})).toBeNull();
    expect(organizationNamesOf({ orgSearch: ['all', 'Acme'] })).toBeNull();
    expect(organizationNamesOf({ orgSearch: ['Acme', 'Unassigned'] })).toEqual(['Acme']);
  });
});

describe('buildAdminUsersMatch hasApiKey', () => {
  const keyed = { ...context, liveApiKeyUserIds: ['b'.repeat(24), 'not-an-object-id'] };

  it('matches the resolved live-key holders by _id, skipping ids that are not ObjectIds', () => {
    expect(conditionsOf(buildAdminUsersMatch({ hasApiKey: 'yes' }, keyed))).toEqual([
      { _id: { $in: [{ objectId: 'b'.repeat(24) }] } },
    ]);
    expect(conditionsOf(buildAdminUsersMatch({ hasApiKey: 'no' }, keyed))).toEqual([
      { _id: { $nin: [{ objectId: 'b'.repeat(24) }] } },
    ]);
  });

  it('refuses a key filter whose holders were not resolved', () => {
    expect(() => buildAdminUsersMatch({ hasApiKey: 'yes' }, context)).toThrow('liveApiKeyUserIds');
  });
});

describe('buildAdminUsersMatch analytics cohorts', () => {
  const id = 'c'.repeat(24);
  const createdFrom = '2026-10-01T00:00:00.000Z';
  const createdTo = '2026-11-01T00:00:00.000Z';
  const resolved = {
    ...context,
    verdictUserIds: [id, 'not-an-object-id'],
    activeUserIds: ['d'.repeat(24)],
    funnelStepUserIds: [],
  };

  it('matches the resolved verdict cohort by _id inside the created window', () => {
    expect(conditionsOf(buildAdminUsersMatch({ verdict: 'legit', createdFrom, createdTo }, resolved))).toEqual([
      { createdAt: { $gte: new Date(createdFrom), $lt: new Date(createdTo) } },
      { _id: { $in: [{ objectId: id }] } },
    ]);
  });

  it('matches the users active in the window', () => {
    expect(conditionsOf(buildAdminUsersMatch({ activeFrom: '2026-10-03', activeTo: '2026-10-03' }, resolved))).toEqual([
      { _id: { $in: [{ objectId: 'd'.repeat(24) }] } },
    ]);
  });

  it('matches nobody when the funnel step resolved to no users', () => {
    expect(conditionsOf(buildAdminUsersMatch({ funnelStep: 'paid', createdFrom, createdTo }, resolved)).at(-1)).toEqual(
      {
        _id: { $in: [] },
      }
    );
  });

  it('refuses a cohort filter whose users were not resolved', () => {
    expect(() => buildAdminUsersMatch({ verdict: 'suspected', createdFrom, createdTo }, context)).toThrow(
      'verdictUserIds'
    );
    expect(() => buildAdminUsersMatch({ activeFrom: '2026-10-01', activeTo: '2026-10-07' }, context)).toThrow(
      'activeUserIds'
    );
    expect(() => buildAdminUsersMatch({ funnelStep: 'signedUp', createdFrom, createdTo }, context)).toThrow(
      'funnelStepUserIds'
    );
  });
});

describe('adminUsersSort', () => {
  it('breaks ties on _id in the same direction', () => {
    expect(adminUsersSort('currentCredits', 'asc')).toEqual({ currentCredits: 1, _id: 1 });
    expect(adminUsersSort('createdAt', 'desc')).toEqual({ createdAt: -1, _id: -1 });
  });
});

describe('AdminUsersQuerySchema', () => {
  it('defaults to the first page of 25, newest first', () => {
    expect(AdminUsersQuerySchema.parse({})).toMatchObject({
      page: 1,
      limit: 25,
      sortField: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('accepts only the list page sizes and known sorts', () => {
    expect(AdminUsersQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(AdminUsersQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
    expect(AdminUsersQuerySchema.safeParse({ sortField: 'password' }).success).toBe(false);
  });

  it('normalizes a domain and rejects one that is not', () => {
    expect(AdminUsersQuerySchema.parse({ emailDomain: ' Example.COM ' }).emailDomain).toBe('example.com');
    expect(AdminUsersQuerySchema.safeParse({ emailDomain: 'a$b' }).success).toBe(false);
  });

  const month = { createdFrom: '2026-10-01T00:00:00.000Z', createdTo: '2026-11-01T00:00:00.000Z' };
  const issuesOf = (query: Record<string, string>) => {
    const parsed = AdminUsersQuerySchema.safeParse(query);
    return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
  };

  it('takes a verdict or funnel step only with a created window of at most 93 days', () => {
    expect(AdminUsersQuerySchema.parse({ ...month, verdict: 'legit', funnelStep: 'cameBack' })).toMatchObject({
      verdict: 'legit',
      funnelStep: 'cameBack',
    });
    expect(issuesOf({ verdict: 'legit', createdFrom: month.createdFrom })).toEqual([
      'verdict needs both createdFrom and createdTo',
    ]);
    expect(issuesOf({ funnelStep: 'paid' })).toEqual(['funnelStep needs both createdFrom and createdTo']);
    expect(
      issuesOf({ verdict: 'legit', createdFrom: month.createdFrom, createdTo: '2027-01-03T00:00:00.000Z' })
    ).toEqual([expect.stringContaining('at most 93 days')]);
    expect(issuesOf({ verdict: 'legit', createdFrom: month.createdTo, createdTo: month.createdFrom })).toHaveLength(1);
    // The window alone keeps its old meaning, with no span cap.
    expect(issuesOf({ createdFrom: '2020-01-01T00:00:00.000Z', createdTo: month.createdTo })).toEqual([]);
  });

  it('takes an active window of real UTC days, both ends, in order, at most 366 days', () => {
    expect(AdminUsersQuerySchema.parse({ activeFrom: '2026-10-03', activeTo: '2026-10-03' })).toMatchObject({
      activeFrom: '2026-10-03',
      activeTo: '2026-10-03',
    });
    expect(issuesOf({ activeFrom: '2025-10-01', activeTo: '2026-10-01' })).toEqual([]);
    expect(issuesOf({ activeFrom: '2025-10-01', activeTo: '2026-10-02' })).toEqual([
      expect.stringContaining('at most 366 days'),
    ]);
    expect(issuesOf({ activeFrom: '2026-10-03' })).toEqual(['activeFrom and activeTo must be set together']);
    expect(issuesOf({ activeTo: '2026-10-03' })).toEqual(['activeFrom and activeTo must be set together']);
    expect(issuesOf({ activeFrom: '2026-10-04', activeTo: '2026-10-03' })).toEqual([
      'activeTo must not be before activeFrom',
    ]);
    expect(issuesOf({ activeFrom: '2026-02-30', activeTo: '2026-03-01' })).toHaveLength(1);
    expect(issuesOf({ activeFrom: '2026-10-03T00:00:00Z', activeTo: '2026-10-04' })).toHaveLength(1);
  });

  it('rejects unknown verdicts and funnel steps', () => {
    expect(issuesOf({ ...month, verdict: 'unclassified' })).toHaveLength(1);
    expect(issuesOf({ ...month, funnelStep: 'bought' })).toHaveLength(1);
  });
});
