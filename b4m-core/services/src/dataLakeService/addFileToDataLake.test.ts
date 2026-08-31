import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKES } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  assertLakeAdmission: vi.fn().mockResolvedValue({ status: 'admitted' }),
}));

// The admission contract's own math (report-only vs enforced, what a violation looks like) is
// covered by lakeAdmissionGate.test.ts. Here we only need to prove addFileToDataLake calls it
// with the right `forceReportOnly` per path - a real assertion needs the actual export, mocked.
vi.mock('./lakeAdmissionGate', () => ({ assertLakeAdmission: h.assertLakeAdmission }));

import { addFileToDataLake } from './addFileToDataLake';

const lake = {
  id: 'lake1',
  name: 'Lake',
  datalakeTag: 'datalake:lake',
  fileTagPrefix: 'lk:',
  createdByUserId: 'owner',
  organizationId: undefined,
  requiredPassageTokenTarget: undefined,
  status: 'active' as const,
};

const owner = { userId: 'owner', isAdmin: false };
const admin = { userId: 'root', isAdmin: true };
const stranger = { userId: 'stranger', isAdmin: false };

type FileTag = { name: string; strength: number };
type FileFixture = { id: string; userId: string; deletedAt?: Date; tags: FileTag[] };

/** A minimal in-memory stand-in for FabFileModel's tag writes, real enough to exercise the
 *  fallback tagger's diff/apply and the restore's push/pull sequencing honestly. */
function makeFabFilesAdapter(initial: FileFixture) {
  const state: FileFixture = { ...initial, tags: [...initial.tags] };
  return {
    findById: vi
      .fn()
      .mockImplementation(async (id: string) => (id === state.id ? { ...state, tags: [...state.tags] } : null)),
    pushTagsByFabFileId: vi.fn().mockImplementation(async (_id: string, names: string[], strength = 0) => {
      let modified = 0;
      for (const name of names) {
        if (!state.tags.some(t => t.name === name)) {
          state.tags.push({ name, strength });
          modified++;
        }
      }
      return modified;
    }),
    pullTagsByFabFileId: vi.fn().mockImplementation(async (_id: string, names: string[]) => {
      const before = state.tags.length;
      state.tags = state.tags.filter(t => !names.includes(t.name));
      return before - state.tags.length;
    }),
    computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10, totalChunkedChars: 0 }),
    _state: state,
  };
}

function makeDataLakesAdapter(lakeDoc: typeof lake = lake) {
  return {
    findById: vi.fn().mockResolvedValue(lakeDoc),
    findByDatalakeTag: vi
      .fn()
      .mockImplementation(async (tag: string) => (tag === lakeDoc.datalakeTag ? lakeDoc : null)),
    find: vi.fn().mockResolvedValue([]), // no colliding lakes for the fallback tagger's overlap check
    setStats: vi.fn().mockResolvedValue(undefined),
    activateIfDraft: vi.fn().mockResolvedValue(false),
  };
}

function makeAdapters(opts: {
  file: FileFixture;
  liveRemoval?: { dataLakeId: string; fabFileId: string; contentTags: FileTag[] } | null;
  lakeDoc?: typeof lake;
  grants?: unknown[];
}) {
  const fabFiles = makeFabFilesAdapter(opts.file);
  const dataLakes = makeDataLakesAdapter(opts.lakeDoc ?? lake);
  const db = {
    dataLakes,
    fabFiles,
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue(opts.grants ?? []) },
    lakeMembershipRemovals: {
      findLive: vi.fn().mockImplementation(async (dataLakeId: string, fabFileId: string) => {
        const r = opts.liveRemoval;
        return r && r.dataLakeId === dataLakeId && r.fabFileId === fabFileId ? r : null;
      }),
    },
    adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  return { db, logger, fabFiles, dataLakes };
}

describe('addFileToDataLake', () => {
  beforeEach(() => {
    h.assertLakeAdmission.mockClear();
    h.assertLakeAdmission.mockResolvedValue({ status: 'admitted' });
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

    await expect(addFileToDataLake(stranger, 'lake1', 'f1', { db, logger })).rejects.toThrow(
      /do not have permission to add files/i
    );
    expect(db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a built-in fallback lake, which has no document to hold membership', async () => {
    const fallbackLake = { ...lake, id: DATA_LAKES[0].id, datalakeTag: DATA_LAKES[0].datalakeTag };
    const { db, logger } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [] },
      lakeDoc: fallbackLake,
    });

    await expect(addFileToDataLake(admin, fallbackLake.id, 'f1', { db, logger })).rejects.toThrow(
      /built into the platform and is read-only/i
    );
    expect(db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted file regardless of a live removal record', async () => {
    const { db, logger } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [], deletedAt: new Date() },
      liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [] },
    });

    await expect(addFileToDataLake(owner, 'lake1', 'f1', { db, logger })).rejects.toThrow(/file not found/i);
    expect(db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  describe('restore path (a live removal record exists)', () => {
    it('admits with NO ownership test - even an admin restoring a third party-owned file', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] }, // neither the actor nor the lake creator
        liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [{ name: 'lk:invoices', strength: 1 }] },
      });

      const result = await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      expect(result.success).toBe(true);
      expect(fabFiles._state.tags.map(t => t.name)).toEqual(expect.arrayContaining(['datalake:lake', 'lk:invoices']));
    });

    it('is admitted when the record carries empty contentTags, and lands under uncategorized', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [] },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      expect(fabFiles._state.tags.map(t => t.name)).toEqual(
        expect.arrayContaining(['datalake:lake', 'lk:uncategorized'])
      );
    });

    it('a record for a different lake cannot authorize this restore - falls to the cold-add ownership guard', async () => {
      const otherLake = { ...lake, id: 'lake2', datalakeTag: 'datalake:lake2', createdByUserId: 'owner' };
      const { db, logger } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [{ name: 'lk:invoices', strength: 1 }] },
        lakeDoc: otherLake,
      });

      // admin can manage lake2, but the record is for lake1 - cold add applies, and 'victim' is
      // owned by neither the actor nor lake2's creator.
      await expect(addFileToDataLake(admin, 'lake2', 'f1', { db, logger })).rejects.toThrow(/file not found/i);
      expect(db.lakeMembershipRemovals.findLive).toHaveBeenCalledWith('lake2', 'f1');
    });

    it('drops a foreign-prefix or reserved-namespace name stored on the record (defence in depth)', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: {
          dataLakeId: 'lake1',
          fabFileId: 'f1',
          contentTags: [
            { name: 'lk:invoices', strength: 1 },
            { name: 'other:foreign', strength: 1 },
            { name: 'datalake:evil', strength: 1 },
            { name: 'DataLake:evil2', strength: 1 },
          ],
        },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      const names = fabFiles._state.tags.map(t => t.name);
      expect(names).toContain('lk:invoices');
      expect(names).not.toContain('other:foreign');
      expect(names).not.toContain('datalake:evil');
      expect(names).not.toContain('DataLake:evil2');
    });

    it('groups restored tags by strength into separate push calls', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: {
          dataLakeId: 'lake1',
          fabFileId: 'f1',
          contentTags: [
            { name: 'lk:invoices', strength: 1 },
            { name: 'lk:urgent', strength: 2 },
          ],
        },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      expect(fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:invoices'], 1);
      expect(fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:urgent'], 2);
      expect(fabFiles._state.tags).toEqual(
        expect.arrayContaining([
          { name: 'lk:invoices', strength: 1 },
          { name: 'lk:urgent', strength: 2 },
        ])
      );
    });

    it('explicitly pulls a stray uncategorized left by an earlier partial restore attempt', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        // Simulates: step 8.1 failed on a prior attempt, 8.3's tagger minted the placeholder.
        file: { id: 'f1', userId: 'victim', tags: [{ name: 'lk:uncategorized', strength: 1 }] },
        liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [{ name: 'lk:invoices', strength: 1 }] },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      const names = fabFiles._state.tags.map(t => t.name);
      expect(names).toContain('lk:invoices');
      expect(names).not.toContain('lk:uncategorized');
    });

    it('does NOT pull uncategorized when it was itself among the restored tags', async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: {
          dataLakeId: 'lake1',
          fabFileId: 'f1',
          contentTags: [
            { name: 'lk:invoices', strength: 1 },
            { name: 'lk:uncategorized', strength: 1 },
          ],
        },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      const names = fabFiles._state.tags.map(t => t.name);
      expect(names).toContain('lk:invoices');
      expect(names).toContain('lk:uncategorized');
    });

    it('grades the admission contract report-only', async () => {
      const { db, logger } = makeAdapters({
        file: { id: 'f1', userId: 'victim', tags: [] },
        liveRemoval: { dataLakeId: 'lake1', fabFileId: 'f1', contentTags: [] },
      });

      await addFileToDataLake(admin, 'lake1', 'f1', { db, logger });

      expect(h.assertLakeAdmission).toHaveBeenCalledWith(
        [lake],
        [expect.objectContaining({ id: 'f1', userId: 'victim' })],
        expect.anything(),
        expect.objectContaining({ forceReportOnly: true })
      );
    });
  });

  describe('cold-add path (no live removal record)', () => {
    it('admits the file owner and lands the file under uncategorized', async () => {
      const { db, logger, fabFiles } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

      const result = await addFileToDataLake(owner, 'lake1', 'f1', { db, logger });

      expect(result.success).toBe(true);
      expect(fabFiles._state.tags.map(t => t.name)).toEqual(
        expect.arrayContaining(['datalake:lake', 'lk:uncategorized'])
      );
    });

    it("refuses a file the actor does not own and is not the lake's effective owner, even for an admin manager", async () => {
      const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'victim', tags: [] } });

      // The admin can MANAGE the lake, but cold-add keeps the ownership guard: no live record
      // means there is nothing establishing this lake ever held this file.
      await expect(addFileToDataLake(admin, 'lake1', 'f1', { db, logger })).rejects.toThrow(/file not found/i);
      expect(db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    // THE coordinate that had no coverage in either direction, and the hole that lived there: a
    // curator user grant clears `canManageLake` (rung 3) without being an effective owner, so an
    // effective-owner arm that tests only `file.userId` admitted them for ANY file the lake's owner
    // owned. Membership is read access, so that published a non-consenting owner's private file to
    // every reader of the lake. The actor side of the arm is what refuses it.
    it("refuses a non-owner CURATOR adding the lake owner's own file - manage rights are not ownership", async () => {
      const { db, logger } = makeAdapters({
        file: { id: 'f1', userId: 'owner', tags: [] },
        grants: [{ principalType: 'user', principalId: 'curator', role: 'curator', status: 'active' }],
      });
      const curator = { userId: 'curator', isAdmin: false };

      await expect(addFileToDataLake(curator, 'lake1', 'f1', { db, logger })).rejects.toThrow(/file not found/i);
      expect(db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    it("admits an effective OWNER-grant holder adding the creator's file - the arm still works for owners", async () => {
      const { db, logger, fabFiles } = makeAdapters({
        file: { id: 'f1', userId: 'owner', tags: [] },
        grants: [{ principalType: 'user', principalId: 'transferee', role: 'owner', status: 'active' }],
      });
      // An owner grant supersedes the creator, so `resolveEffectiveOwnerIds` is ['transferee'] and
      // the creator's own file is NOT reachable through the arm - but the transferee's is.
      const transferee = { userId: 'transferee', isAdmin: false };

      await expect(addFileToDataLake(transferee, 'lake1', 'f1', { db, logger })).rejects.toThrow(/file not found/i);

      const own = makeAdapters({
        file: { id: 'f2', userId: 'transferee', tags: [] },
        grants: [{ principalType: 'user', principalId: 'transferee', role: 'owner', status: 'active' }],
      });
      const result = await addFileToDataLake(transferee, 'lake1', 'f2', { db: own.db, logger: own.logger });
      expect(result.success).toBe(true);
      expect(own.fabFiles._state.tags.map(t => t.name)).toContain('datalake:lake');
      expect(fabFiles._state.tags).toEqual([]);
    });

    it('keeps the platform-admin rung exactly as wide as it was - lake-owner file yes, third party no', async () => {
      const ownerFile = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });
      const result = await addFileToDataLake(admin, 'lake1', 'f1', {
        db: ownerFile.db,
        logger: ownerFile.logger,
      });
      expect(result.success).toBe(true);

      // Not widened to "any file in the database" - the admin rung gates the same file-side test.
      const thirdParty = makeAdapters({ file: { id: 'f2', userId: 'victim', tags: [] } });
      await expect(
        addFileToDataLake(admin, 'lake1', 'f2', { db: thirdParty.db, logger: thirdParty.logger })
      ).rejects.toThrow(/file not found/i);
    });

    it('is idempotent on a retry', async () => {
      const { db, logger, fabFiles } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

      await addFileToDataLake(owner, 'lake1', 'f1', { db, logger });
      const afterFirst = [...fabFiles._state.tags];
      await addFileToDataLake(owner, 'lake1', 'f1', { db, logger });

      expect(fabFiles._state.tags).toEqual(afterFirst);
    });

    it('grades the admission contract enforced (not report-only)', async () => {
      const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

      await addFileToDataLake(owner, 'lake1', 'f1', { db, logger });

      expect(h.assertLakeAdmission).toHaveBeenCalledWith(
        [lake],
        [expect.objectContaining({ id: 'f1', userId: 'owner' })],
        expect.anything(),
        expect.objectContaining({ forceReportOnly: false })
      );
    });
  });

  it('recomputes and returns the lake stats', async () => {
    const { db, logger, dataLakes } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

    const result = await addFileToDataLake(owner, 'lake1', 'f1', { db, logger });

    expect(dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 1,
      totalSizeBytes: 10,
      totalChunkedChars: 0,
    });
    expect(result).toEqual({ success: true, fileCount: 1, totalSizeBytes: 10, totalChunkedChars: 0 });
  });
});
