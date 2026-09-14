import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  AdminSettings: class AdminSettings {},
  CounterLog: class CounterLog {},
  Session: class Session {
    static find() {
      return { select: () => [] };
    }
  },
  User: class User {},
  Invite: class Invite {},
  Prompt: class Prompt {},
  UserActivityCounter: class UserActivityCounter {},
  FeedbackModel: class FeedbackModel {},
  ModalModel: class ModalModel {},
  Organization: class Organization {},
  FabFile: class FabFile {},
  Memento: class Memento {},
  Project: class Project {},
  QuestMasterPlan: class QuestMasterPlan {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  SecretRotation: class SecretRotation {},
}));

vi.mock('@server/models/Subscription', () => ({
  Subscription: class Subscription {},
}));

import defineAbilitiesFor from '../ability';
import { Prompt, FabFile, FeedbackModel } from '@bike4mind/database';
import { accessibleBy } from '@casl/mongoose';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({
    id: 'u1',
    isAdmin: false,
    tags: [],
    groups: [],
    email: 'user@example.com',
    ...overrides,
  }) as IUserDocument;

describe('defineAbilitiesFor - Prompt library permissions', () => {
  it('everyone (any authenticated user) can read Prompts', () => {
    const ability = defineAbilitiesFor(makeUser());
    expect(ability.can('read', Prompt)).toBe(true);
  });

  it('an admin can create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ isAdmin: true }));
    expect(ability.can('create', Prompt)).toBe(true);
    expect(ability.can('update', Prompt)).toBe(true);
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('a developer-tagged user can create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['Developer'] }));
    expect(ability.can('create', Prompt)).toBe(true);
    expect(ability.can('update', Prompt)).toBe(true);
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('matches the developer tag case-insensitively, mirroring hasDeveloperUserTag', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['developer'] }));
    expect(ability.can('delete', Prompt)).toBe(true);
  });

  it('a plain user (neither admin nor developer) cannot create/update/delete Prompts', () => {
    const ability = defineAbilitiesFor(makeUser({ tags: ['Customer'] }));
    expect(ability.can('create', Prompt)).toBe(false);
    expect(ability.can('update', Prompt)).toBe(false);
    expect(ability.can('delete', Prompt)).toBe(false);
  });

  it('the literal "Analyst" tag alone (no admin, no developer) no longer grants Prompt write access', () => {
    // The gate used to be Analyst-tag-only, with no admin fallback - replaced
    // with admin-or-developer (2026-07-08). A lone Analyst tag is not developer.
    const ability = defineAbilitiesFor(makeUser({ tags: ['Analyst'] }));
    expect(ability.can('create', Prompt)).toBe(false);
    expect(ability.can('update', Prompt)).toBe(false);
    expect(ability.can('delete', Prompt)).toBe(false);
  });

  it('undefined user gets no abilities at all', () => {
    const ability = defineAbilitiesFor(undefined);
    expect(ability.can('read', Prompt)).toBe(false);
    expect(ability.can('create', Prompt)).toBe(false);
  });
});

// Org Groups Phase 2b (#1174): exercise the dormant `user.groups` consumer in the
// CASL access gate with a NON-empty groups array. `groups[]` on a shareable doc pairs a
// groupId with the permissions that group is granted; access requires the user to be a
// member of a group whose entry carries the requested permission.
describe('defineAbilitiesFor - group-shared document access', () => {
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

  it('denies when the matched group lacks the requested permission', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g1'] }));
    const doc = sharedWithGroups([{ groupId: 'g1', permissions: ['share'] }]);
    expect(ability.can('read', doc)).toBe(false);
    expect(ability.can('share', doc)).toBe(true);
  });

  it('denies when the user has no groups (empty array is the prod no-op)', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: [] }));
    const doc = sharedWithGroups([{ groupId: 'g1', permissions: ['read'] }]);
    expect(ability.can('read', doc)).toBe(false);
  });

  // The over-broad-grant guard: groupId and permission must hold on the SAME entry.
  // The user is in g1 (granted only `share`); `read` is granted to g2, which they are
  // NOT in. A dotted filter would satisfy the two conditions across the two entries and
  // leak read; $elemMatch keeps them denied.
  it('does not leak a permission granted to a different group (no cross-element match)', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g1'] }));
    const doc = sharedWithGroups([
      { groupId: 'g1', permissions: ['share'] },
      { groupId: 'g2', permissions: ['read'] },
    ]);
    expect(ability.can('read', doc)).toBe(false);
  });

  it('resolves the right entry when a doc is shared with several groups', () => {
    const ability = defineAbilitiesFor(makeUser({ groups: ['g2'] }));
    const doc = sharedWithGroups([
      { groupId: 'g1', permissions: ['read'] },
      { groupId: 'g2', permissions: ['read', 'update'] },
    ]);
    expect(ability.can('update', doc)).toBe(true);
  });
});

describe('defineAbilitiesFor - Feedback read/delete scoping', () => {
  // A reporter owns fb-own; someone else owns fb-other. Instances, not the class: every non-admin
  // feedback grant carries a { userId } condition, and a by-class check does not evaluate it.
  const ownReport = Object.assign(new FeedbackModel(), { userId: 'u1' });
  const othersReport = Object.assign(new FeedbackModel(), { userId: 'someone-else' });

  it('lets a reporter read and retract their OWN report', () => {
    const ability = defineAbilitiesFor(makeUser());
    expect(ability.can('read', ownReport)).toBe(true);
    expect(ability.can('delete', ownReport)).toBe(true);
  });

  it("denies a reporter reading or deleting SOMEONE ELSE'S report", () => {
    const ability = defineAbilitiesFor(makeUser());
    expect(ability.can('read', othersReport)).toBe(false);
    expect(ability.can('delete', othersReport)).toBe(false);
  });

  it('lets an admin read and delete any report', () => {
    const ability = defineAbilitiesFor(makeUser({ isAdmin: true }));
    expect(ability.can('read', othersReport)).toBe(true);
    expect(ability.can('delete', othersReport)).toBe(true);
  });

  it('pins the footgun these grants create: the by-class check passes for a non-owner', () => {
    // This is why every feedback route authorizes against the fetched instance (read/update/
    // delete) or narrows the query with accessibleBy (list). If a route ever reverts to a
    // by-class check, it hands every logged-in user the admin view - and this assertion is the
    // record of why that check is not safe here.
    const ability = defineAbilitiesFor(makeUser());
    expect(ability.can('read', FeedbackModel)).toBe(true);
    expect(ability.can('delete', FeedbackModel)).toBe(true);
    expect(ability.can('read', othersReport)).toBe(false);
    expect(ability.can('delete', othersReport)).toBe(false);
  });

  it('narrows a list query to the caller for a non-admin, and not at all for an admin', () => {
    // accessibleBy is what pages/api/feedback/index.ts uses to scope the list; these are the two
    // shapes it must produce.
    const reporterScope = accessibleBy(defineAbilitiesFor(makeUser()), 'read').ofType(FeedbackModel);
    expect(JSON.stringify(reporterScope)).toContain('u1');

    const adminScope = accessibleBy(defineAbilitiesFor(makeUser({ isAdmin: true })), 'read').ofType(FeedbackModel);
    expect(adminScope).toEqual({});
  });

  it('fails closed for a caller with no read grant at all', () => {
    // An unsatisfiable filter, never an empty one: an empty filter would match the whole
    // collection.
    const scope = accessibleBy(defineAbilitiesFor(undefined), 'read').ofType(FeedbackModel);
    expect(scope).toEqual({ $expr: { $eq: [0, 1] } });
    expect(scope).not.toEqual({});
  });
});
