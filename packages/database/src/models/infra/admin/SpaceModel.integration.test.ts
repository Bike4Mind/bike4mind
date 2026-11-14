import { describe, it, expect, beforeEach } from 'vitest';
import { ISpaceMember } from '@bike4mind/common';
import { Space, spaceRepository } from './SpaceModel';
import { setupMongoTest } from '../../../__test__/utils';

const OWNER = 'owner-1';

const member = (userId: string, role: ISpaceMember['role'] = 'member'): ISpaceMember => ({
  userId,
  role,
  joinedVia: 'invite',
  joinedAt: new Date(),
});

const createSpace = (overrides: Record<string, unknown> = {}) =>
  spaceRepository.create({ name: 'Team', ownerUserId: OWNER, members: [], removedUserIds: [], ...overrides });

describe('SpaceModel', () => {
  setupMongoTest();

  beforeEach(async () => {
    await Space.deleteMany({}, { hardDelete: true });
    await Space.syncIndexes();
  });

  describe('addMember', () => {
    it('respects the cap', async () => {
      const space = await createSpace();
      const id = String(space.id);
      expect(await spaceRepository.addMember(id, member('u1'), { cap: 2, clearRemoved: false })).not.toBeNull();
      expect(await spaceRepository.addMember(id, member('u2'), { cap: 2, clearRemoved: false })).not.toBeNull();
      expect(await spaceRepository.addMember(id, member('u3'), { cap: 2, clearRemoved: false })).toBeNull();
    });

    it('never overshoots the cap under concurrent adds', async () => {
      const space = await createSpace();
      const id = String(space.id);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          spaceRepository.addMember(id, member(`u${i}`), { cap: 5, clearRemoved: false })
        )
      );
      const after = await spaceRepository.findLiveById(id);
      expect(after?.members).toHaveLength(5);
    });

    it('refuses the owner and an existing member', async () => {
      const space = await createSpace({ members: [member('u1')] });
      const id = String(space.id);
      expect(await spaceRepository.addMember(id, member(OWNER), { cap: 10, clearRemoved: true })).toBeNull();
      expect(await spaceRepository.addMember(id, member('u1'), { cap: 10, clearRemoved: true })).toBeNull();
      expect((await spaceRepository.findLiveById(id))?.members).toHaveLength(1);
    });

    it('refuses a deleted Space', async () => {
      const space = await createSpace();
      const id = String(space.id);
      expect(await spaceRepository.softDelete(id, OWNER)).toBe(true);
      expect(await spaceRepository.addMember(id, member('u1'), { cap: 10, clearRemoved: true })).toBeNull();
    });

    it('refuses a removed user unless clearRemoved, which also lifts the block', async () => {
      const space = await createSpace({ removedUserIds: ['u1'] });
      const id = String(space.id);
      expect(await spaceRepository.addMember(id, member('u1'), { cap: 10, clearRemoved: false })).toBeNull();
      const joined = await spaceRepository.addMember(id, member('u1'), { cap: 10, clearRemoved: true });
      expect(joined?.members.map(m => m.userId)).toEqual(['u1']);
      expect(joined?.removedUserIds).toEqual([]);
    });
  });

  describe('removeMember', () => {
    it('never removes the owner', async () => {
      const space = await createSpace({ members: [member('u1')] });
      expect(await spaceRepository.removeMember(String(space.id), OWNER, { block: true })).toBeNull();
      expect((await spaceRepository.findLiveById(String(space.id)))?.ownerUserId).toBe(OWNER);
    });

    it('adds to removedUserIds only when blocking', async () => {
      const space = await createSpace({ members: [member('u1'), member('u2')] });
      const id = String(space.id);
      const left = await spaceRepository.removeMember(id, 'u1', { block: false });
      expect(left?.removedUserIds).toEqual([]);
      const removed = await spaceRepository.removeMember(id, 'u2', { block: true });
      expect(removed?.members).toHaveLength(0);
      expect(removed?.removedUserIds).toEqual(['u2']);
    });
  });

  describe('setMemberRole', () => {
    it('changes a member role and never the owner', async () => {
      const space = await createSpace({ members: [member('u1')] });
      const id = String(space.id);
      const promoted = await spaceRepository.setMemberRole(id, 'u1', 'admin');
      expect(promoted?.members[0].role).toBe('admin');
      expect(await spaceRepository.setMemberRole(id, OWNER, 'admin')).toBeNull();
    });
  });

  describe('transferOwnership', () => {
    it('fails unless the target is an admin', async () => {
      const space = await createSpace({ members: [member('u1')] });
      expect(await spaceRepository.transferOwnership(String(space.id), OWNER, 'u1', { clearParent: false })).toBeNull();
    });

    it('fails unless the caller is the owner', async () => {
      const space = await createSpace({ members: [member('u1', 'admin')] });
      expect(
        await spaceRepository.transferOwnership(String(space.id), 'other', 'u1', { clearParent: false })
      ).toBeNull();
    });

    it('swaps owner and admin row, and clears the parent on request', async () => {
      const space = await createSpace({
        members: [member('u1', 'admin'), member('u2')],
        parentOrganizationId: 'org-1',
      });
      const id = String(space.id);
      const after = await spaceRepository.transferOwnership(id, OWNER, 'u1', { clearParent: true });
      expect(after?.ownerUserId).toBe('u1');
      expect(after?.members.find(m => m.userId === 'u1')).toBeUndefined();
      expect(after?.members.find(m => m.userId === OWNER)).toMatchObject({ role: 'admin' });
      expect(after?.members.find(m => m.userId === 'u2')).toMatchObject({ role: 'member' });
      expect(after?.parentOrganizationId).toBeNull();
    });
  });

  describe('soft-deleted Spaces', () => {
    it('are skipped by listForUser and findLiveById', async () => {
      const space = await createSpace({ members: [member('u1')] });
      const id = String(space.id);
      expect(await spaceRepository.listForUser('u1')).toHaveLength(1);
      expect(await spaceRepository.softDelete(id, OWNER)).toBe(true);
      expect(await spaceRepository.listForUser('u1')).toHaveLength(0);
      expect(await spaceRepository.listForUser(OWNER)).toHaveLength(0);
      expect(await spaceRepository.findLiveById(id)).toBeNull();
      expect(await spaceRepository.countOwned(OWNER)).toBe(0);
    });

    it('only the owner can delete', async () => {
      const space = await createSpace();
      expect(await spaceRepository.softDelete(String(space.id), 'u1')).toBe(false);
    });
  });
});
