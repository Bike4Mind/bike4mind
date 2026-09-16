import { describe, it, expect } from 'vitest';
import { Permission } from '../types/entities/ShareableDocumentTypes';
import { canUpdateShareable, grantablePermissions, heldPermissions } from './shareableAccess';

describe('canUpdateShareable', () => {
  const doc = (users: Array<{ userId: string; permissions: Permission[] }>, groups = []) => ({
    userId: 'owner',
    users,
    groups,
  });

  it('grants the owner', () => {
    expect(canUpdateShareable(doc([]), 'owner')).toBe(true);
  });

  it('denies a read-only sharee', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.read] }]), 'bob')).toBe(false);
  });

  it('denies a share-only sharee, matching findUpdateAccessById', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.share] }]), 'bob')).toBe(false);
  });

  it('grants a sharee holding update', () => {
    expect(canUpdateShareable(doc([{ userId: 'bob', permissions: [Permission.read, Permission.update] }]), 'bob')).toBe(
      true
    );
  });

  it('grants via a group update grant only when the caller is in that group', () => {
    const shared = { userId: 'owner', users: [], groups: [{ groupId: 'grp-1', permissions: [Permission.update] }] };
    expect(canUpdateShareable(shared, 'bob', ['grp-1'])).toBe(true);
    expect(canUpdateShareable(shared, 'bob', ['grp-2'])).toBe(false);
    expect(canUpdateShareable(shared, 'bob')).toBe(false);
  });

  it('denies an absent document or caller', () => {
    expect(canUpdateShareable(null, 'bob')).toBe(false);
    expect(canUpdateShareable(doc([]), undefined)).toBe(false);
  });
});

/**
 * Both are load-bearing for the two re-share caps: createInvite refuses to mint a permission the
 * sharer does not hold, and acceptInvite caps a propagated file grant at what the inviter holds.
 */
describe('heldPermissions', () => {
  const doc = (
    users: Array<{ userId: string; permissions: Permission[] }> = [],
    groups: Array<{ groupId: string; permissions: Permission[] }> = []
  ) => ({ userId: 'owner', users, groups });

  it('gives the owner every permission regardless of the share arrays', () => {
    const held = heldPermissions(doc(), 'owner');
    for (const permission of Object.values(Permission)) expect(held.has(permission)).toBe(true);
  });

  it('returns nothing for an absent doc or caller', () => {
    expect(heldPermissions(null, 'u1').size).toBe(0);
    expect(heldPermissions(doc(), undefined).size).toBe(0);
  });

  it('reads the caller own users[] entry and nobody else', () => {
    const held = heldPermissions(
      doc([
        { userId: 'u1', permissions: [Permission.read] },
        { userId: 'u2', permissions: [Permission.delete] },
      ]),
      'u1'
    );
    expect([...held]).toEqual([Permission.read]);
  });

  it('unions across several rows for the same user', () => {
    // pushShareable keys rows on (userId, projectId), so one user can hold more than one.
    const held = heldPermissions(
      doc([
        { userId: 'u1', permissions: [Permission.read] },
        { userId: 'u1', permissions: [Permission.update] },
      ]),
      'u1'
    );
    expect(held.has(Permission.read)).toBe(true);
    expect(held.has(Permission.update)).toBe(true);
  });

  it('adds a group grant only for a group the caller belongs to', () => {
    const d = doc([], [{ groupId: 'g1', permissions: [Permission.update] }]);
    expect(heldPermissions(d, 'u1', ['g1']).has(Permission.update)).toBe(true);
    expect(heldPermissions(d, 'u1', ['g2']).has(Permission.update)).toBe(false);
    expect(heldPermissions(d, 'u1').has(Permission.update)).toBe(false);
  });

  it('ignores a stored value that is not a real permission', () => {
    const held = heldPermissions(doc([{ userId: 'u1', permissions: ['bogus' as Permission] }]), 'u1');
    expect(held.size).toBe(0);
  });
});

describe('grantablePermissions', () => {
  const doc = (users: Array<{ userId: string; permissions: Permission[] }> = []) => ({
    userId: 'owner',
    users,
    groups: [],
  });

  it('lets a share-only sharee convey read', () => {
    // Minting an invite already requires share authority, so a collaborator granted share alone is
    // the normal case and has to be able to pass on the read that share implies.
    const grantable = grantablePermissions(doc([{ userId: 'u1', permissions: [Permission.share] }]), 'u1');
    expect(grantable.has(Permission.read)).toBe(true);
    expect(grantable.has(Permission.share)).toBe(true);
  });

  it('does not invent anything above read', () => {
    const grantable = grantablePermissions(doc([{ userId: 'u1', permissions: [Permission.share] }]), 'u1');
    expect(grantable.has(Permission.update)).toBe(false);
    expect(grantable.has(Permission.delete)).toBe(false);
  });

  it('does not conjure read for a sharee without share', () => {
    const grantable = grantablePermissions(doc([{ userId: 'u1', permissions: [Permission.update] }]), 'u1');
    expect(grantable.has(Permission.read)).toBe(false);
    expect(grantable.has(Permission.update)).toBe(true);
  });

  it('matches heldPermissions for the owner', () => {
    expect([...grantablePermissions(doc(), 'owner')].sort()).toEqual([...heldPermissions(doc(), 'owner')].sort());
  });
});
