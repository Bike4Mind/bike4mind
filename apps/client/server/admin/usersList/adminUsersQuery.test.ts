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
});
