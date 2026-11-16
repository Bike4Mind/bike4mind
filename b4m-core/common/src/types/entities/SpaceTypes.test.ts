import { describe, it, expect } from 'vitest';
import { isSpaceManager, isSpaceMember, isSpaceOwner, ISpace } from './SpaceTypes';

const space: Pick<ISpace, 'ownerUserId' | 'members'> = {
  ownerUserId: 'owner',
  members: [
    { userId: 'admin', role: 'admin', joinedVia: 'invite', joinedAt: new Date() },
    { userId: 'member', role: 'member', joinedVia: 'link', joinedAt: new Date() },
  ],
};

describe('space access helpers', () => {
  it('treats only the owner as owner', () => {
    expect(isSpaceOwner('owner', space)).toBe(true);
    expect(isSpaceOwner('admin', space)).toBe(false);
  });

  it('counts the owner and every member row as members', () => {
    expect(isSpaceMember('owner', space)).toBe(true);
    expect(isSpaceMember('admin', space)).toBe(true);
    expect(isSpaceMember('member', space)).toBe(true);
    expect(isSpaceMember('stranger', space)).toBe(false);
  });

  it('counts the owner and admins as managers, not plain members', () => {
    expect(isSpaceManager('owner', space)).toBe(true);
    expect(isSpaceManager('admin', space)).toBe(true);
    expect(isSpaceManager('member', space)).toBe(false);
    expect(isSpaceManager('stranger', space)).toBe(false);
  });
});
