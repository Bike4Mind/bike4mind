import { describe, expect, it } from 'vitest';
import { AdminSettings, Organization, defineAbilitiesFor as defineDbCoreAbilitiesFor } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/common';
import defineAbilitiesFor from './ability';

const member = { id: 'user-1', isAdmin: false, tags: [] } as unknown as IUserDocument;
const setting = (settingName: string) => new AdminSettings({ settingName, settingValue: 'x' });

describe('AdminSettings read ability for a non-admin', () => {
  it('reads the model-list revision, which wakes an open model picker', () => {
    expect(defineAbilitiesFor(member).can('read', setting('modelListRevision'))).toBe(true);
  });

  it('reads the model access revision, which wakes an open model picker after an access change', () => {
    expect(defineAbilitiesFor(member).can('read', setting('modelAccessRevision'))).toBe(true);
  });

  it('still cannot read a setting outside the allowlist', () => {
    expect(defineAbilitiesFor(member).can('read', setting('enforceCredits'))).toBe(false);
  });
});

// The HTTP builder and db-core's (packages/database/src/utils/ability.ts) share the Organization arm;
// this checks they reach the same verdicts on the same docs. The HTTP builder's extra manager rule
// is covered separately because db-core has no equivalent.
describe('Organization read scope', () => {
  type AclRow = { userId?: string; groupId?: string; permissions: string[] };
  const user = { id: 'u1', isAdmin: false, tags: [], groups: ['g1'] } as unknown as IUserDocument;
  const org = (fields: { userId?: string; users?: AclRow[]; groups?: AclRow[]; isGlobalRead?: boolean }) =>
    new Organization({ name: 'Acme', userId: 'owner', ...fields });

  const cases: Array<[string, ReturnType<typeof org>, boolean]> = [
    ['owner', org({ userId: 'u1' }), true],
    ['users[] read row', org({ users: [{ userId: 'u1', permissions: ['read'] }] }), true],
    ['users[] write row', org({ users: [{ userId: 'u1', permissions: ['write'] }] }), true],
    ['isGlobalRead alone', org({ isGlobalRead: true }), false],
    ['group share alone', org({ groups: [{ groupId: 'g1', permissions: ['read'] }] }), false],
  ];

  it.each(cases)('%s -> read %s, and both builders agree', (_label, doc, expected) => {
    expect(defineAbilitiesFor(user).can('read', doc)).toBe(expected);
    expect(defineDbCoreAbilitiesFor(user).can('read', doc)).toBe(expected);
  });

  it('lets a current manager with a roster row read', () => {
    const managed = org({ adminUserIds: ['u1'], users: [{ userId: 'u1', permissions: [] }] } as never);
    expect(defineAbilitiesFor(user).can('read', managed)).toBe(true);
  });
});
