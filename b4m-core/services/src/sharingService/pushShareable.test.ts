import { describe, it, expect } from 'vitest';
import { IShareableDocument, Permission } from '@bike4mind/common';
import { pushShareable } from './accept';

const asEntity = (users: IShareableDocument['users'] = []): IShareableDocument =>
  ({ id: 'doc-1', isGlobalRead: false, isGlobalWrite: false, users, groups: [] }) as unknown as IShareableDocument;

describe('sharingService - pushShareable', () => {
  it('adds a fresh entry with exactly the granted permissions', () => {
    const entity = asEntity();

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read, Permission.share] });

    expect(entity.users).toEqual([
      { userId: 'user-1', permissions: [Permission.read, Permission.share], projectId: undefined },
    ]);
  });

  it('preserves an existing projectId when the new grant does not carry one', () => {
    // A user with project-cascaded access (accept.ts's acceptProject arm) later accepts a
    // direct FabFile/Session invite for the same document (accept.ts's `update` has no
    // projectId) -- that must not silently disassociate them from the project.
    const entity = asEntity([{ userId: 'user-1', permissions: [Permission.read], projectId: 'project-9' }]);

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read, Permission.share] });

    expect(entity.users[0].projectId).toBe('project-9');
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

  it('carries a new projectId forward when one is provided', () => {
    const entity = asEntity([{ userId: 'user-1', permissions: [Permission.read] }]);

    pushShareable(entity, { userId: 'user-1', permissions: [Permission.read], projectId: 'project-42' });

    expect(entity.users[0].projectId).toBe('project-42');
  });
});
