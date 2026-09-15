import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { skillRepository, Skill } from '../SkillModel';
import { setupMongoTest } from '../../../__test__/utils';

function makeUserSkillInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: new mongoose.Types.ObjectId().toString(),
    name: 'summarize',
    description: 'Summarize the user input in three bullets.',
    body: 'Summarize the following text in exactly three bullets:\n\n$ARGUMENTS',
    ...overrides,
  };
}

function makeOrgSkillInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: new mongoose.Types.ObjectId().toString(),
    name: 'team-review',
    description: 'Team-canonical PR review skill.',
    body: 'Review the PR at $1 using the team rubric.',
    ...overrides,
  };
}

describe('SkillRepository', () => {
  setupMongoTest();

  describe('scope discriminator', () => {
    it('accepts a user-scoped skill', async () => {
      const created = await Skill.create(makeUserSkillInput());
      expect(created.userId).toBeTruthy();
      expect(created.organizationId).toBeUndefined();
      expect(created.isSystem).toBeFalsy();
    });

    it('accepts an org-scoped skill', async () => {
      const created = await Skill.create(makeOrgSkillInput());
      expect(created.organizationId).toBeTruthy();
      expect(created.userId).toBeUndefined();
    });

    it('accepts a system skill', async () => {
      const created = await Skill.create({
        name: 'built-in',
        description: 'A built-in skill.',
        body: 'Do something.',
        isSystem: true,
      });
      expect(created.isSystem).toBe(true);
    });

    it('rejects a skill with no scope set', async () => {
      await expect(Skill.create({ name: 'orphan', description: 'no scope', body: 'x' })).rejects.toThrow(
        /exactly one of/
      );
    });

    it('rejects a skill with multiple scopes set', async () => {
      await expect(
        Skill.create({
          name: 'overscoped',
          description: 'too many scopes',
          body: 'x',
          userId: new mongoose.Types.ObjectId().toString(),
          organizationId: new mongoose.Types.ObjectId().toString(),
        })
      ).rejects.toThrow(/exactly one of/);
    });
  });

  describe('listForUser', () => {
    it('returns only the requested user and excludes soft-deleted', async () => {
      const userA = new mongoose.Types.ObjectId().toString();
      const userB = new mongoose.Types.ObjectId().toString();

      await Skill.create(makeUserSkillInput({ userId: userA, name: 'a-one' }));
      await Skill.create(makeUserSkillInput({ userId: userA, name: 'a-two' }));
      const toDelete = await Skill.create(makeUserSkillInput({ userId: userA, name: 'a-three' }));
      await Skill.create(makeUserSkillInput({ userId: userB, name: 'b-one' }));

      await Skill.updateOne({ _id: toDelete._id }, { $set: { deletedAt: new Date() } });

      const list = await skillRepository.listForUser(userA);
      expect(list.map(s => s.name).sort()).toEqual(['a-one', 'a-two']);
    });
  });

  describe('listForOrganization', () => {
    it('returns only the requested org', async () => {
      const orgA = new mongoose.Types.ObjectId().toString();
      const orgB = new mongoose.Types.ObjectId().toString();

      await Skill.create(makeOrgSkillInput({ organizationId: orgA, name: 'one' }));
      await Skill.create(makeOrgSkillInput({ organizationId: orgB, name: 'one' }));

      const result = await skillRepository.listForOrganization(orgA);
      expect(result).toHaveLength(1);
      expect(result[0]?.organizationId).toBe(orgA);
    });
  });

  describe('listSystem', () => {
    it('returns only system skills', async () => {
      await Skill.create(makeUserSkillInput({ name: 'user-skill' }));
      await Skill.create({
        name: 'sys',
        description: 'sys',
        body: 'b',
        isSystem: true,
      });

      const result = await skillRepository.listSystem();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('sys');
    });
  });

  describe('findByName lookups', () => {
    it('isolates name lookups by scope', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'shared-name' }));

      const result = await skillRepository.findByNameForUser(userId, 'shared-name');
      expect(result).toBeNull();
    });
  });

  describe('listInvocableForUser', () => {
    it('caps results at the requested limit, excludes disableModelInvocation, and orders by updatedAt desc', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const now = Date.now();

      // Create 5 skills, then stamp updatedAt explicitly. Mongoose's
      // `timestamps: true` overwrites updatedAt on create, so we set it after.
      for (let i = 0; i < 5; i++) {
        const skill = await Skill.create(makeUserSkillInput({ userId, name: `s-${i}` }));
        await Skill.updateOne(
          { _id: skill._id },
          { $set: { updatedAt: new Date(now - i * 1000) } },
          { timestamps: false }
        );
      }
      // Plus one disableModelInvocation skill - should be excluded even
      // though its updatedAt would top the sort.
      const hidden = await Skill.create({
        ...makeUserSkillInput({ userId, name: 'hidden' }),
        disableModelInvocation: true,
      });
      await Skill.updateOne({ _id: hidden._id }, { $set: { updatedAt: new Date(now + 1000) } }, { timestamps: false });

      const result = await skillRepository.listInvocableForUser(userId, 3);
      expect(result).toHaveLength(3);
      // updatedAt desc - s-0 is newest invocable, hidden excluded.
      expect(result.map(s => s.name)).toEqual(['s-0', 's-1', 's-2']);
    });
  });

  describe('findByNamesForUser', () => {
    it('returns matched skills via single $in query', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'one' }));
      await Skill.create(makeUserSkillInput({ userId, name: 'two' }));
      await Skill.create(makeUserSkillInput({ userId, name: 'three' }));

      const result = await skillRepository.findByNamesForUser(userId, ['one', 'three', 'missing']);
      expect(result.map(s => s.name).sort()).toEqual(['one', 'three']);
    });

    it('returns [] for an empty name list (no query fired)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const result = await skillRepository.findByNamesForUser(userId, []);
      expect(result).toEqual([]);
    });

    it('does not match other users skills', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'shared-name' }));

      const result = await skillRepository.findByNamesForUser(userId, ['shared-name']);
      expect(result).toEqual([]);
    });
  });

  describe('searchAccessible', () => {
    it('returns owned + shared skills, with pagination', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();

      await Skill.create(makeUserSkillInput({ userId, name: 'mine-one' }));
      await Skill.create(makeUserSkillInput({ userId, name: 'mine-two' }));
      await Skill.create(
        makeUserSkillInput({
          userId: otherUserId,
          name: 'shared-with-me',
          users: [{ userId, permissions: ['read'] }],
        })
      );
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'not-shared' }));

      const { data, total } = await skillRepository.searchAccessible(
        userId,
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'name', direction: 'asc' }
      );

      const names = data.map(s => s.name).sort();
      expect(names).toEqual(['mine-one', 'mine-two', 'shared-with-me']);
      expect(total).toBe(3);
    });

    it('matches name and description with case-insensitive search', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'summarize', description: 'Summarize text.' }));
      await Skill.create(makeUserSkillInput({ userId, name: 'translate', description: 'Translate text.' }));

      const { data } = await skillRepository.searchAccessible(
        userId,
        'SUMMARIZE',
        {},
        { page: 1, limit: 10 },
        { by: 'name', direction: 'asc' }
      );

      expect(data).toHaveLength(1);
      expect(data[0]?.name).toBe('summarize');
    });

    it('does NOT surface system or org skills without scope context', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'mine' }));
      await Skill.create({ name: 'sys', description: 'sys', body: 'b', isSystem: true });
      await Skill.create(makeOrgSkillInput({ name: 'org-one' }));

      const { data } = await skillRepository.searchAccessible(
        userId,
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'name', direction: 'asc' }
      );
      expect(data.map(s => s.name)).toEqual(['mine']);
    });

    it('surfaces system skills to an admin via scope', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'mine' }));
      await Skill.create({ name: 'sys', description: 'sys', body: 'b', isSystem: true });

      const { data } = await skillRepository.searchAccessible(
        userId,
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'name', direction: 'asc' },
        { isAdmin: true }
      );
      expect(data.map(s => s.name).sort()).toEqual(['mine', 'sys']);
    });

    it('surfaces org skills for the orgs the caller administers', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const myOrg = new mongoose.Types.ObjectId().toString();
      const otherOrg = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'mine' }));
      await Skill.create(makeOrgSkillInput({ organizationId: myOrg, name: 'my-org-skill' }));
      await Skill.create(makeOrgSkillInput({ organizationId: otherOrg, name: 'other-org-skill' }));

      const { data } = await skillRepository.searchAccessible(
        userId,
        '',
        {},
        { page: 1, limit: 10 },
        { by: 'name', direction: 'asc' },
        { adminOrganizationIds: [myOrg] }
      );
      expect(data.map(s => s.name).sort()).toEqual(['mine', 'my-org-skill']);
    });
  });

  describe('listAccessibleInvocableForUser', () => {
    it('spans owned + shared + global-read, excludes disableModelInvocation', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();

      await Skill.create(makeUserSkillInput({ userId, name: 'mine' }));
      await Skill.create(
        makeUserSkillInput({ userId: otherUserId, name: 'shared', users: [{ userId, permissions: ['read'] }] })
      );
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'global', isGlobalRead: true }));
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'private' })); // not accessible
      await Skill.create(
        makeUserSkillInput({ userId, name: 'hidden', disableModelInvocation: true }) // excluded
      );

      const result = await skillRepository.listAccessibleInvocableForUser(userId, 50);
      expect(result.map(s => s.name).sort()).toEqual(['global', 'mine', 'shared']);
    });

    it('caps results at the requested limit', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      for (let i = 0; i < 5; i++) {
        await Skill.create(makeUserSkillInput({ userId, name: `s-${i}` }));
      }
      const result = await skillRepository.listAccessibleInvocableForUser(userId, 3);
      expect(result).toHaveLength(3);
    });
  });

  describe('findAccessibleByNameForUser', () => {
    it('resolves a global-read skill the user does not own', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'global', isGlobalRead: true }));

      const result = await skillRepository.findAccessibleByNameForUser(userId, 'global');
      expect(result?.name).toBe('global');
    });

    it('returns null for an inaccessible skill', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'private' }));

      const result = await skillRepository.findAccessibleByNameForUser(userId, 'private');
      expect(result).toBeNull();
    });

    it("prefers the user's own skill over a global one on a name collision", async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'dup', body: 'MINE' }));
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'dup', body: 'THEIRS', isGlobalRead: true }));

      const result = await skillRepository.findAccessibleByNameForUser(userId, 'dup');
      expect(result?.body).toBe('MINE');
    });
  });

  describe('findAccessibleByNamesForUser', () => {
    it('batches a $in lookup across scopes, one row per name (owner-preferred)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Skill.create(makeUserSkillInput({ userId, name: 'dup', body: 'MINE' }));
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'dup', body: 'THEIRS', isGlobalRead: true }));
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'global', isGlobalRead: true }));
      await Skill.create(makeUserSkillInput({ userId: otherUserId, name: 'private' }));

      const result = await skillRepository.findAccessibleByNamesForUser(userId, [
        'dup',
        'global',
        'private',
        'missing',
      ]);
      const byName = new Map(result.map(s => [s.name, s]));
      expect(byName.size).toBe(2); // dup + global; private and missing excluded
      expect(byName.get('dup')?.body).toBe('MINE');
      expect(byName.get('global')?.name).toBe('global');
    });

    it('returns [] for an empty name list (no query fired)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const result = await skillRepository.findAccessibleByNamesForUser(userId, []);
      expect(result).toEqual([]);
    });
  });
});
