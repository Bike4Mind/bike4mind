import { describe, it, expect, vi } from 'vitest';

import { setDataLakeFileTags } from './setDataLakeFileTags';

type LakeGrant = { principalType: 'user' | 'organization'; principalId: string; role: 'owner' | 'curator' };
type LakeFixture = {
  id: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix: string;
  createdByUserId: string;
  organizationId?: string;
  requiredPassageTokenTarget?: number;
  status?: 'draft' | 'active';
};
type FileTag = { name: string; strength: number };
type FileFixture = {
  id: string;
  userId: string;
  tags: FileTag[];
  deletedAt?: Date;
  primaryTag?: string;
  chunkedPassageTokenTarget?: number;
};

const lake: LakeFixture = {
  id: 'lake1',
  name: 'Lake One',
  datalakeTag: 'datalake:lake1',
  fileTagPrefix: 'lk:',
  createdByUserId: 'owner',
  status: 'active',
};

const owner = { userId: 'owner', isAdmin: false };
const admin = { userId: 'root', isAdmin: true };
const stranger = { userId: 'stranger', isAdmin: false };
const curator = { userId: 'curator', isAdmin: false };
const orgAdmin = { userId: 'org-admin', isAdmin: false, administeredOrgIds: ['org1'] };

/** A minimal in-memory stand-in for FabFileModel's tag writes. */
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
      if (state.primaryTag && names.includes(state.primaryTag)) state.primaryTag = undefined;
      return before - state.tags.length;
    }),
    computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10, totalChunkedChars: 0 }),
    _state: state,
  };
}

function makeDataLakesAdapter(lakes: LakeFixture[]) {
  return {
    findById: vi.fn().mockImplementation(async (id: string) => lakes.find(l => l.id === id) ?? null),
    findByDatalakeTag: vi
      .fn()
      .mockImplementation(async (tag: string) => lakes.find(l => l.datalakeTag === tag) ?? null),
    // Mimics just enough Mongo query shape to serve `findCollidingPrefixLakes` (`$or` on
    // createdByUserId/organizationId) and `loadPrefixArmCandidateLakes` (`createdByUserId: {$in}`).
    find: vi.fn().mockImplementation(async (query: Record<string, unknown>) => {
      if (query && Array.isArray((query as { $or?: unknown[] }).$or)) {
        const clauses = (query as { $or: Record<string, unknown>[] }).$or;
        return lakes.filter(l =>
          clauses.some(c => Object.entries(c).every(([k, v]) => (l as Record<string, unknown>)[k] === v))
        );
      }
      const inClause = (query as { createdByUserId?: { $in?: string[] } })?.createdByUserId?.$in;
      if (inClause) return lakes.filter(l => inClause.includes(l.createdByUserId));
      return [];
    }),
    setStats: vi.fn().mockResolvedValue(undefined),
    activateIfDraft: vi.fn().mockImplementation(async (id: string) => {
      const target = lakes.find(l => l.id === id);
      if (target && target.status !== 'active') {
        target.status = 'active';
        return true;
      }
      return false;
    }),
  };
}

function makeGrantsAdapter(grantsByLake: Record<string, LakeGrant[]> = {}) {
  return {
    listByLake: vi.fn().mockImplementation(async (lakeId: string) => grantsByLake[lakeId] ?? []),
    listActiveByLakes: vi
      .fn()
      .mockImplementation(async (lakeIds: string[]) =>
        lakeIds.flatMap(id => (grantsByLake[id] ?? []).map(g => ({ ...g, dataLakeId: id })))
      ),
  };
}

function makeAdapters(opts: { file: FileFixture; lakes?: LakeFixture[]; grants?: Record<string, LakeGrant[]> }) {
  const fabFiles = makeFabFilesAdapter(opts.file);
  const dataLakes = makeDataLakesAdapter(opts.lakes ?? [lake]);
  const dataLakeAccessGrants = makeGrantsAdapter(opts.grants ?? {});
  const db = {
    dataLakes,
    fabFiles,
    dataLakeAccessGrants,
    adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
  };
  const logger = { warn: vi.fn(), log: vi.fn() };
  return { db, logger, fabFiles, dataLakes, dataLakeAccessGrants };
}

describe('setDataLakeFileTags', () => {
  it('refuses a caller who cannot manage the lake, before touching the file', async () => {
    const { db, logger, fabFiles } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

    await expect(setDataLakeFileTags(stranger, 'lake1', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /do not have permission/i
    );
    expect(fabFiles.findById).not.toHaveBeenCalled();
    expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a built-in fallback lake', async () => {
    // 'opti-knowledge' is a real DATA_LAKES registry id, so `isFallbackLake` recognizes this
    // fixture by id alone regardless of its other (synthetic) fields.
    const fallbackLake: LakeFixture = { ...lake, id: 'opti-knowledge' };
    const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] }, lakes: [fallbackLake] });

    await expect(setDataLakeFileTags(admin, 'opti-knowledge', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /read-only/i
    );
  });

  it('404s on a missing file', async () => {
    const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [] } });

    await expect(setDataLakeFileTags(owner, 'lake1', 'no-such-file', ['lk:x'], { db, logger })).rejects.toThrow(
      /file not found/i
    );
  });

  it('404s on a soft-deleted file', async () => {
    const { db, logger } = makeAdapters({ file: { id: 'f1', userId: 'owner', tags: [], deletedAt: new Date() } });

    await expect(setDataLakeFileTags(owner, 'lake1', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /file not found/i
    );
  });

  it('refuses a file that carries no membership signal for this lake at all (the bootstrap-hole test)', async () => {
    const { db, logger, fabFiles } = makeAdapters({ file: { id: 'f1', userId: 'stranger', tags: [] } });

    await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /file not found/i
    );
    expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('the AC: a curator grant, a creator-owned file, and no removal record replaces the tag set and sheds the stale placeholder', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'owner',
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'lk:uncategorized', strength: 1 },
        ],
      },
      grants: { lake1: [{ principalType: 'user', principalId: 'curator', role: 'curator' }] },
    });

    const result = await setDataLakeFileTags(curator, 'lake1', 'f1', ['lk:reports', 'lk:invoices'], { db, logger });

    expect(result.success).toBe(true);
    const names = fabFiles._state.tags.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['datalake:lake1', 'lk:reports', 'lk:invoices']));
    expect(names).not.toContain('lk:uncategorized');
    expect(result.tags.added.sort()).toEqual(['lk:invoices', 'lk:reports']);
    expect(result.tags.removed).toEqual(['lk:uncategorized']);
  });

  it('admits an org admin', async () => {
    const orgLake: LakeFixture = { ...lake, organizationId: 'org1' };
    const { db, logger } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
      lakes: [orgLake],
    });

    const result = await setDataLakeFileTags(orgAdmin, 'lake1', 'f1', ['lk:reports'], { db, logger });
    expect(result.success).toBe(true);
  });

  it('admits a platform admin', async () => {
    const { db, logger } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
    });

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:reports'], { db, logger });
    expect(result.success).toBe(true);
  });

  it('refuses to empty a prefix-only member down to nothing, and writes nothing', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'lk:invoices', strength: 1 }] },
    });

    await expect(setDataLakeFileTags(admin, 'lake1', 'f1', [], { db, logger })).rejects.toThrow(
      /would remove the file from/i
    );
    expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(fabFiles._state.tags.map(t => t.name)).toEqual(['lk:invoices']);
  });

  it('lets a prefix-only member escape to the uncategorized placeholder instead', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'lk:invoices', strength: 1 }] },
    });

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:uncategorized'], { db, logger });

    expect(result.success).toBe(true);
    expect(fabFiles._state.tags.map(t => t.name)).toEqual(['lk:uncategorized']);
  });

  it('mints the uncategorized placeholder for a meta-tag member emptied to nothing', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: { id: 'f1', userId: 'stranger', tags: [{ name: 'datalake:lake1', strength: 1 }] },
    });

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', [], { db, logger });

    expect(result.success).toBe(true);
    const names = fabFiles._state.tags.map(t => t.name);
    expect(names).toContain('datalake:lake1');
    expect(names).toContain('lk:uncategorized');
  });

  describe('body validation (section 4) - each refusal writes nothing', () => {
    const base = { file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] } };

    it('rejects a name in the reserved datalake: namespace', async () => {
      const { db, logger, fabFiles } = makeAdapters(base);
      await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['datalake:evil'], { db, logger })).rejects.toThrow(
        /reserved/i
      );
      expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    it("rejects a name not under the lake's prefix", async () => {
      const { db, logger, fabFiles } = makeAdapters(base);
      await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['other:thing'], { db, logger })).rejects.toThrow(
        /not under this lake's tag prefix/i
      );
      expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    it('rejects the bare prefix with an empty suffix', async () => {
      const { db, logger, fabFiles } = makeAdapters(base);
      await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:'], { db, logger })).rejects.toThrow(
        /no name after the prefix/i
      );
      expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    it('rejects a name with trailing whitespace (leading whitespace is already caught by the prefix check, since it moves the string off the prefix)', async () => {
      const { db, logger, fabFiles } = makeAdapters(base);
      await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:invoices '], { db, logger })).rejects.toThrow(
        /whitespace/i
      );
      expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    });

    it('silently collapses duplicates rather than erroring', async () => {
      const { db, logger, fabFiles } = makeAdapters(base);
      const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:invoices', 'lk:invoices'], { db, logger });
      expect(result.tags.added).toEqual(['lk:invoices']);
      expect(fabFiles._state.tags.filter(t => t.name === 'lk:invoices')).toHaveLength(1);
    });
  });

  it('is idempotent: re-PUTting the same set issues zero tag writes on the second call', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
    });

    await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:invoices'], { db, logger });
    fabFiles.pushTagsByFabFileId.mockClear();
    fabFiles.pullTagsByFabFileId.mockClear();

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:invoices'], { db, logger });

    expect(result.tags.added).toEqual([]);
    expect(result.tags.removed).toEqual([]);
    expect(fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
    expect(fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('a surviving tag keeps its stored strength; a new tag carries the content-tag constant', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'owner',
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'lk:invoices', strength: 0.7 },
        ],
      },
    });

    await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:invoices', 'lk:reports'], { db, logger });

    const byName = new Map(fabFiles._state.tags.map(t => [t.name, t.strength]));
    expect(byName.get('lk:invoices')).toBe(0.7);
    expect(byName.get('lk:reports')).toBe(1);
  });

  it('pushes before it pulls', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'owner',
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'lk:stale', strength: 1 },
        ],
      },
    });

    await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:fresh'], { db, logger });

    const pushOrder = fabFiles.pushTagsByFabFileId.mock.invocationCallOrder[0];
    const pullOrder = fabFiles.pullTagsByFabFileId.mock.invocationCallOrder[0];
    expect(pushOrder).toBeLessThan(pullOrder);
  });

  it('on a non-creator-owned member, a stale caller-authored name is retained (not stripped) while the stale placeholder IS shed', async () => {
    const { db, logger, fabFiles } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'stranger', // does NOT own the lake -> this lake's own removal reach is empty
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'lk:stale', strength: 1 },
          { name: 'lk:uncategorized', strength: 1 },
        ],
      },
    });

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:fresh'], { db, logger });

    expect(result.tags.retained).toEqual(['lk:stale']);
    expect(result.tags.removed).toEqual(['lk:uncategorized']);
    expect(fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['lk:uncategorized']);
    const names = fabFiles._state.tags.map(t => t.name);
    expect(names).toContain('lk:stale');
    expect(names).toContain('lk:fresh');
    expect(names).not.toContain('lk:uncategorized');
  });

  it('an existing under-prefix name over the length cap is retained rather than pulled', async () => {
    const overCapName = `lk:${'x'.repeat(200)}`;
    const { db, logger, fabFiles } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'owner',
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: overCapName, strength: 1 },
        ],
      },
    });

    const result = await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:fresh'], { db, logger });

    expect(result.tags.retained).toEqual([overCapName]);
    expect(fabFiles.pullTagsByFabFileId).not.toHaveBeenCalledWith('f1', expect.arrayContaining([overCapName]));
    expect(fabFiles._state.tags.map(t => t.name)).toContain(overCapName);
  });

  it('refuses when the lake prefix overlaps another lake in scope', async () => {
    const collidingLake: LakeFixture = {
      ...lake,
      id: 'lake2',
      name: 'Lake Two',
      datalakeTag: 'datalake:lake2',
      fileTagPrefix: 'lk:sub:',
    };
    const { db, logger } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
      lakes: [lake, collidingLake],
    });

    await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /prefix-overlap|cannot be used right now/i
    );
  });

  it('refuses when the overlap check itself fails, rather than fail open like the live write doors', async () => {
    const { db, logger, dataLakes } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
    });
    dataLakes.find.mockRejectedValueOnce(new Error('boom'));

    await expect(setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:x'], { db, logger })).rejects.toThrow(
      /could not verify/i
    );
  });

  it("logs primaryTagCleared when the pulled set includes the file's primaryTag", async () => {
    const { db, logger } = makeAdapters({
      file: {
        id: 'f1',
        userId: 'owner',
        tags: [
          { name: 'datalake:lake1', strength: 1 },
          { name: 'lk:stale', strength: 1 },
        ],
        primaryTag: 'lk:stale',
      },
    });

    await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:fresh'], { db, logger });

    expect(logger.log).toHaveBeenCalledWith(
      '[dataLakes] lake file tags replaced',
      expect.objectContaining({ primaryTagCleared: true })
    );
  });

  it("recomputes this lake's stats", async () => {
    const { db, logger, dataLakes } = makeAdapters({
      file: { id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] },
    });

    await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:reports'], { db, logger });

    expect(dataLakes.setStats).toHaveBeenCalledWith('lake1', expect.anything());
  });

  describe("a co-prefixed third lake reached only through the file owner (not the URL lake's creator)", () => {
    // lake1 is owned by a DIFFERENT user than the file - so decideStampPrefix's collision scope
    // (anchored on lake1's OWN creator/org) cannot see lakeB, which is owned by the file's owner.
    // Only step 11 (anchored on the file's owner) can classify this as a join.
    const lakeB: LakeFixture = {
      id: 'lakeB',
      name: 'Lake B',
      datalakeTag: 'datalake:lakeb',
      fileTagPrefix: 'lk:fresh:',
      createdByUserId: 'fileOwner',
      status: 'draft',
    };
    const fileFixture: FileFixture = {
      id: 'f1',
      userId: 'fileOwner',
      tags: [
        { name: 'datalake:lake1', strength: 1 },
        { name: 'lk:stale', strength: 1 },
      ],
    };

    it("corrects lake B's stats without activating it when the actor does not manage lake B", async () => {
      const { db, logger, dataLakes } = makeAdapters({
        file: fileFixture,
        lakes: [lake, lakeB],
        grants: { lake1: [{ principalType: 'user', principalId: 'curator', role: 'curator' }] },
      });

      const result = await setDataLakeFileTags(curator, 'lake1', 'f1', ['lk:fresh:doc'], { db, logger });

      expect(result.success).toBe(true);
      expect(dataLakes.setStats).toHaveBeenCalledWith('lakeB', expect.anything());
      expect(dataLakes.activateIfDraft).not.toHaveBeenCalledWith('lakeB');
    });

    it('activates lake B too when the actor DOES manage it (a platform admin)', async () => {
      const { db, logger, dataLakes } = makeAdapters({
        file: fileFixture,
        lakes: [lake, { ...lakeB, status: 'draft' }],
      });

      await setDataLakeFileTags(admin, 'lake1', 'f1', ['lk:fresh:doc'], { db, logger });

      expect(dataLakes.activateIfDraft).toHaveBeenCalledWith('lakeB');
    });
  });
});
