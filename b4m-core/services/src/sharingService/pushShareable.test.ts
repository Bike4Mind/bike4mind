import { describe, it, expect } from 'vitest';
import { IShareableDocument, Permission } from '@bike4mind/common';
import { pushShareable } from './accept';

const asEntity = (users: IShareableDocument['users'] = []): IShareableDocument =>
  ({ id: 'doc-1', isGlobalRead: false, isGlobalWrite: false, users, groups: [] }) as unknown as IShareableDocument;

describe('sharingService - pushShareable', () => {
  it('adds a fresh entry with exactly the granted permissions', () => {
    const entity = asEntity();

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read, Permission.share] });

    // toStrictEqual, not toEqual: toEqual treats an `undefined`-valued key as equal to an absent
    // one, so the two provenance tags below would assert nothing under it.
    expect(entity.users).toStrictEqual([
      {
        userId: 'user-1',
        permissions: [Permission.read, Permission.share],
        projectId: undefined,
        sessionId: undefined,
      },
    ]);
  });

  it('leaves an existing project entry alone and records a direct grant as its own row', () => {
    // A user with project-cascaded access (accept.ts's acceptProject arm) later accepts a
    // direct FabFile/Session invite for the same document (accept.ts's `update` has no
    // projectId) -- that must not silently disassociate them from the project, and the direct
    // grant has to survive a later revoke of the project on its own row.
    const entity = asEntity([{ userId: 'user-1', permissions: [Permission.read], projectId: 'project-9' }]);

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read, Permission.share] });

    expect(entity.users).toStrictEqual([
      { userId: 'user-1', permissions: [Permission.read], projectId: 'project-9' },
      {
        userId: 'user-1',
        permissions: [Permission.read, Permission.share],
        projectId: undefined,
        sessionId: undefined,
      },
    ]);
  });

  it('unions permissions instead of narrowing them on a re-share', () => {
    const entity = asEntity([
      { userId: 'user-1', permissions: [Permission.read, Permission.update, Permission.share] },
    ]);

    // A plain By-Users invite only ever grants [read, share] -- accepting it must not strip
    // the update permission this user already held from a broader grant.
    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read, Permission.share] });

    expect(new Set(entity.users[0].permissions)).toEqual(
      new Set([Permission.read, Permission.update, Permission.share])
    );
  });

  it('does not retag a direct share when a project later grants the same document', () => {
    // Retagging in place is what made revoke's scoped arm unable to keep its promise: once the
    // untagged row carried project-42, revoking that project deleted the direct share with it.
    const entity = asEntity([{ userId: 'user-1', permissions: [Permission.read] }]);

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], projectId: 'project-42' });

    expect(entity.users).toEqual([
      { userId: 'user-1', permissions: [Permission.read] },
      { userId: 'user-1', permissions: [Permission.read], projectId: 'project-42' },
    ]);
  });

  it('keeps each project on its own row when two projects reach the same document', () => {
    const entity = asEntity();

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], projectId: 'project-a' });
    pushShareable(entity, { userId: 'user-1', permissions: [Permission.update], projectId: 'project-b' });

    expect(entity.users).toEqual([
      { userId: 'user-1', permissions: [Permission.read], projectId: 'project-a' },
      { userId: 'user-1', permissions: [Permission.update], projectId: 'project-b' },
    ]);
  });

  // The sessionId clause of the key. Two sessions can each propagate the same file to the same
  // person; revoking one must not take the other's grant, which needs two rows to be true.
  it('keeps each session on its own row when two sessions reach the same document', () => {
    const entity = asEntity();

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], sessionId: 'session-a' });
    pushShareable(entity, { userId: 'user-1', permissions: [Permission.update], sessionId: 'session-b' });

    expect(entity.users).toEqual([
      { userId: 'user-1', permissions: [Permission.read], projectId: undefined, sessionId: 'session-a' },
      { userId: 'user-1', permissions: [Permission.update], projectId: undefined, sessionId: 'session-b' },
    ]);
  });

  // The destructive merge this tag exists to prevent, at the level of the key itself: a direct
  // share and a session propagation to the same user collapsed into one row while they shared a
  // key, so the session cascade deleted the direct share along with its own grant.
  it('does not merge a session propagation into an existing direct share', () => {
    const entity = asEntity([{ userId: 'user-1', permissions: [Permission.read] }]);

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], sessionId: 'session-a' });

    expect(entity.users).toEqual([
      { userId: 'user-1', permissions: [Permission.read] },
      { userId: 'user-1', permissions: [Permission.read], projectId: undefined, sessionId: 'session-a' },
    ]);
  });

  // A project grant and a session grant are different provenances even for the same user and doc.
  it('keeps a project row and a session row separate', () => {
    const entity = asEntity();

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], projectId: 'project-a' });
    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], sessionId: 'session-a' });

    expect(entity.users).toHaveLength(2);
  });
});
