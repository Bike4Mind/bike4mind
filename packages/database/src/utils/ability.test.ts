import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// The ability builder pulls in the Mongoose models purely as CASL subject types;
// stub them so this stays a pure permission-rule unit test (no DB).
vi.mock('../models', () => ({
  Session: class Session {},
  User: class User {},
  FabFile: class FabFile {},
  Organization: class Organization {},
  AdminSettings: class AdminSettings {},
  ModalModel: class ModalModel {},
  CounterLog: class CounterLog {},
  FeedbackModel: class FeedbackModel {},
  Invite: class Invite {},
  Prompt: class Prompt {},
  UserActivityCounter: class UserActivityCounter {},
}));

import { defineAbilitiesFor } from './ability';
import { Prompt, FabFile } from '../models';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'u1', isAdmin: false, tags: [], groups: [], email: 'user@example.com', ...overrides }) as IUserDocument;

// Mirrors the HTTP ability (apps/client/server/auth/ability.ts) - both must gate
// Prompt writes on admin-or-developer and stay in sync (the two definitions
// diverging on the retired 'Analyst' tag is exactly what this guards against).
describe('db-core defineAbilitiesFor - Prompt library', () => {
  it('lets any authenticated user read Prompts', () => {
    expect(defineAbilitiesFor(makeUser()).can('read', Prompt)).toBe(true);
  });

  it('lets an admin create/update/delete Prompts', () => {
    const a = defineAbilitiesFor(makeUser({ isAdmin: true }));
    expect(a.can('create', Prompt)).toBe(true);
    expect(a.can('update', Prompt)).toBe(true);
    expect(a.can('delete', Prompt)).toBe(true);
  });

  it('lets a developer-tagged user create/update/delete Prompts (case-insensitive per hasDeveloperUserTag)', () => {
    expect(defineAbilitiesFor(makeUser({ tags: ['Developer'] })).can('create', Prompt)).toBe(true);
    expect(defineAbilitiesFor(makeUser({ tags: ['developer'] })).can('delete', Prompt)).toBe(true);
  });

  it('denies a plain user Prompt writes', () => {
    const a = defineAbilitiesFor(makeUser({ tags: ['Customer'] }));
    expect(a.can('create', Prompt)).toBe(false);
    expect(a.can('update', Prompt)).toBe(false);
    expect(a.can('delete', Prompt)).toBe(false);
  });

  it('no longer grants Prompt writes on the retired "Analyst" tag alone', () => {
    const a = defineAbilitiesFor(makeUser({ tags: ['Analyst'] }));
    expect(a.can('create', Prompt)).toBe(false);
    expect(a.can('update', Prompt)).toBe(false);
    expect(a.can('delete', Prompt)).toBe(false);
  });

  it('grants nothing to an undefined user', () => {
    expect(defineAbilitiesFor(undefined).can('read', Prompt)).toBe(false);
  });
});

// Org Groups (#1172): the db-core ability is the copy the quest/slack processors and the
// image/video generators compile into a Mongo query via accessibleBy - the path where a
// cross-element group match actually bites. Must stay in sync with the HTTP ability
// (apps/client/server/auth/ability.ts); these mirror that file's group tests exactly.
describe('db-core defineAbilitiesFor - group-shared document access', () => {
  type GroupShare = { groupId: string; permissions: string[] };
  const sharedWithGroups = (groups: GroupShare[]) =>
    Object.assign(new FabFile(), { userId: 'owner', users: [], groups });

  it('grants read to a member of a group the doc shares read with', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g1'] }));
    const doc = sharedWithGroups([{ groupId: 'g1', permissions: ['read'] }]);
    expect(ability.can('read', doc)).toBe(true);
  });

  it('denies a non-member (no overlapping group id)', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g-other'] }));
    const doc = sharedWithGroups([{ groupId: 'g1', permissions: ['read'] }]);
    expect(ability.can('read', doc)).toBe(false);
  });

  // The over-broad-grant guard: groupId and permission must hold on the SAME entry.
  // The user is in g1 (granted only `share`); `read` is granted to g2, which they are
  // NOT in. A dotted filter satisfied the two conditions across the two entries and
  // leaked read; $elemMatch keeps them denied.
  it('does not leak a permission granted to a different group (no cross-element match)', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g1'] }));
    const doc = sharedWithGroups([
      { groupId: 'g1', permissions: ['share'] },
      { groupId: 'g2', permissions: ['read'] },
    ]);
    expect(ability.can('read', doc)).toBe(false);
    expect(ability.can('share', doc)).toBe(true);
  });

  it('denies when the user has no groups (empty array is the prod no-op)', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: [] }));
    const doc = sharedWithGroups([{ groupId: 'g1', permissions: ['read'] }]);
    expect(ability.can('read', doc)).toBe(false);
  });
});
