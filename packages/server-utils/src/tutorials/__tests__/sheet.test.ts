// Copyright (c) Bike4Mind, Inc. All rights reserved. SPDX-License-Identifier: LicenseRef-Bike4Mind-Proprietary
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialRequest } from '../routes/types';
import type { TutorialModule } from '../types';

type Row = { _id: string; fileName: string; tags?: { name: string }[]; deletedAt?: Date | null; createdAt?: Date };
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  queries: [] as unknown[],
  inserted: 0,
  restamps: [] as unknown[],
  restampFails: false,
}));
const createFabFile = vi.hoisted(() => vi.fn());
const deleteFabFile = vi.hoisted(() => vi.fn());

const TAG = 'tutorial:fixture';
const tagged = (row: Row, tag = TAG) => (row.tags ?? [{ name: TAG }]).some(t => t.name === tag);

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
  dataLakeRepository: {},
  organizationRepository: {},
  User: {},
  withTransaction: (fn: () => unknown) => fn(),
  FabFile: {
    find: (query: { _id?: { $in: string[] }; 'tags.name'?: string }) => {
      db.queries.push(query);
      let includeDeleted = false;
      const chain = {
        setOptions: (options: { includeDeleted?: boolean }) => {
          includeDeleted = !!options.includeDeleted;
          return chain;
        },
        select: () => chain,
        sort: () => chain,
        lean: async () => {
          await Promise.resolve();
          const ids = query._id?.$in;
          return db.rows
            .filter(row => (ids ? ids.includes(row._id) : tagged(row, query['tags.name'])))
            .filter(row => includeDeleted || !row.deletedAt)
            .sort((x, y) => x._id.localeCompare(y._id))
            .map(row => ({ ...row, tags: row.tags ?? [{ name: TAG }] }));
        },
      };
      return chain;
    },
    // Only the restamp: moves a row's createdAt, the key the File Browser's Recent sorts by.
    updateOne: (
      filter: { _id: string; userId: string },
      update: { $set: { createdAt: Date } },
      options: { overwriteImmutable?: boolean }
    ) => ({
      exec: async () => {
        db.restamps.push({ filter, options });
        if (db.restampFails) throw new Error('write failed');
        const row = db.rows.find(r => r._id === filter._id);
        if (row) row.createdAt = update.$set.createdAt;
        return { matchedCount: row ? 1 : 0 };
      },
    }),
    create: async (doc: Omit<Row, '_id'> & { _id?: string }) => {
      // Stands in for the storage upload that runs before the insert, so racers interleave here.
      await new Promise(resolve => setTimeout(resolve, 0));
      const _id = doc._id ?? `f${100 + db.inserted}`;
      if (db.rows.some(row => row._id === _id)) throw Object.assign(new Error('E11000'), { code: 11000 });
      db.inserted++;
      db.rows.push({ _id, fileName: doc.fileName, tags: doc.tags, createdAt: new Date() });
      return doc;
    },
  },
}));
vi.mock('@bike4mind/services', () => ({ fabFilesService: { createFabFile, deleteFabFile } }));
vi.mock('../../utils/storage/index', () => ({ getFilesStorage: () => ({}) }));

import { ensureTutorialSheet, sheetContentTag, tutorialSheetSlotId } from '../sheet';

type SheetFixture = TutorialModule & { sheet: NonNullable<TutorialModule['sheet']> };
const CONFIG = { tag: 'tutorial', legacyCopyIsCurrent: (m: TutorialModule) => m.id === 'fixture' };
const sheetModule = {
  id: 'fixture',
  sheet: { name: 'Fixture-3.csv', csv: 'a,b\n', retired: ['Fixture-2.csv'] },
} as unknown as SheetFixture;
const req = { user: { id: 'u1' }, logger: { warn: vi.fn() } } as unknown as TutorialRequest;
const slot = (n: number) => tutorialSheetSlotId('u1', TAG, sheetModule.sheet.name, n);

describe('ensureTutorialSheet', () => {
  beforeEach(() => {
    db.rows = [];
    db.queries = [];
    db.inserted = 0;
    db.restamps = [];
    db.restampFails = false;
    createFabFile
      .mockReset()
      .mockImplementation(
        async (
          _userId: string,
          params: { fileName: string; tags: Row['tags'] },
          adapters: { db: { fabFiles: { create: (d: unknown) => Promise<unknown> } } }
        ) => adapters.db.fabFiles.create({ fileName: params.fileName, tags: params.tags })
      );
    deleteFabFile.mockReset().mockImplementation(async (_userId: string, { id }: { id: string }) => {
      const row = db.rows.find(r => r._id === id);
      if (row) row.deletedAt = new Date();
      return { action: 'deleted' };
    });
  });

  it("looks only at the user's live copies carrying the module's tag", async () => {
    db.rows = [{ _id: 'f1', fileName: sheetModule.sheet.name }];
    await ensureTutorialSheet(CONFIG, req, sheetModule);
    expect(db.queries[0]).toEqual({ userId: 'u1', 'tags.name': TAG, deletedAt: null });
  });

  it('returns the copy the user has, creating and deleting nothing', async () => {
    db.rows = [{ _id: 'f1', fileName: sheetModule.sheet.name }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f1');
    expect(createFabFile).not.toHaveBeenCalled();
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('keeps the oldest copy under the current name and deletes its twins', async () => {
    db.rows = [
      { _id: 'f3', fileName: sheetModule.sheet.name },
      { _id: 'f2', fileName: sheetModule.sheet.name },
    ];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f2');
    expect(deleteFabFile.mock.calls.map(c => [c[0], c[1]])).toEqual([['u1', { id: 'f3' }]]);
  });

  it('creates the current sheet beside a retired one, then deletes the retired one', async () => {
    db.rows = [{ _id: 'f1', fileName: 'Fixture-2.csv' }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(0));
    expect(createFabFile).toHaveBeenCalledTimes(1);
    expect(createFabFile.mock.calls[0][1]).toMatchObject({
      fileName: sheetModule.sheet.name,
      tags: [
        { name: TAG, strength: 1 },
        { name: sheetContentTag(CONFIG.tag, sheetModule.sheet.csv), strength: 1 },
      ],
    });
    expect(createFabFile.mock.calls[0][2]).toMatchObject({ objectKey: `${slot(0)}.csv` });
    expect(deleteFabFile.mock.calls.map(c => [c[0], c[1]])).toEqual([['u1', { id: 'f1' }]]);
  });

  it('issues a fresh copy when the CSV under the same name changed, and deletes the old one', async () => {
    db.rows = [
      {
        _id: 'f1',
        fileName: sheetModule.sheet.name,
        tags: [{ name: TAG }, { name: sheetContentTag(CONFIG.tag, 'old\n') }],
      },
    ];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(0));
    expect(createFabFile).toHaveBeenCalledTimes(1);
    expect(deleteFabFile.mock.calls.map(c => [c[0], c[1]])).toEqual([['u1', { id: 'f1' }]]);
  });

  it('reuses a same-name copy that holds the same CSV', async () => {
    db.rows = [
      {
        _id: 'f1',
        fileName: sheetModule.sheet.name,
        tags: [{ name: TAG }, { name: sheetContentTag(CONFIG.tag, sheetModule.sheet.csv) }],
      },
    ];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f1');
    expect(createFabFile).not.toHaveBeenCalled();
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it("reuses a repo module's copy issued before content tags, but reissues a draft's", async () => {
    db.rows = [{ _id: 'f1', fileName: sheetModule.sheet.name, tags: [{ name: TAG }] }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f1');
    expect(createFabFile).not.toHaveBeenCalled();

    const draftTag = 'tutorial:my-fixture';
    const draft = { id: 'my-fixture', sheet: { name: 'draft.csv', csv: 'a,b\n' } } as unknown as SheetFixture;
    db.rows = [{ _id: 'd1', fileName: 'draft.csv', tags: [{ name: draftTag }] }];
    expect(await ensureTutorialSheet(CONFIG, req, draft)).toBe(tutorialSheetSlotId('u1', draftTag, 'draft.csv', 0));
    expect(deleteFabFile.mock.calls.map(c => [c[0], c[1]])).toEqual([['u1', { id: 'd1' }]]);
  });

  it("does not adopt a draft's slot copy that holds a different CSV, and issues the next slot", async () => {
    const draftTag = 'tutorial:my-fixture';
    const draft = { id: 'my-fixture', sheet: { name: 'draft.csv', csv: 'a,b\n' } } as unknown as SheetFixture;
    const draftSlot = (n: number) => tutorialSheetSlotId('u1', draftTag, 'draft.csv', n);
    db.rows = [
      {
        _id: draftSlot(0),
        fileName: 'draft.csv',
        tags: [{ name: draftTag }, { name: sheetContentTag(CONFIG.tag, 'old\n') }],
      },
    ];
    expect(await ensureTutorialSheet(CONFIG, req, draft)).toBe(draftSlot(1));
    expect(deleteFabFile.mock.calls.map(c => [c[0], c[1]])).toEqual([['u1', { id: draftSlot(0) }]]);
  });

  it('keeps a copy the user renamed, and makes the current sheet beside it', async () => {
    db.rows = [{ _id: 'f1', fileName: 'my-fixture.csv' }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(0));
    expect(deleteFabFile).not.toHaveBeenCalled();
  });

  it('still hands back the sheet when a stale copy will not delete', async () => {
    db.rows = [
      { _id: 'f1', fileName: sheetModule.sheet.name },
      { _id: 'f2', fileName: sheetModule.sheet.name },
    ];
    deleteFabFile.mockRejectedValue(new Error('storage down'));
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f1');
    expect(req.logger.warn).toHaveBeenCalled();
  });

  it('writes one copy when calls race past the lookup, even if no delete succeeds', async () => {
    deleteFabFile.mockRejectedValue(new Error('storage down'));
    const ids = await Promise.all([1, 2, 3].map(() => ensureTutorialSheet(CONFIG, req, sheetModule)));
    expect(db.rows.filter(row => !row.deletedAt)).toHaveLength(1);
    expect(db.inserted).toBe(1);
    expect(new Set(ids)).toEqual(new Set([slot(0)]));
  });

  it('hands every later call the copy the first one made', async () => {
    const first = await ensureTutorialSheet(CONFIG, req, sheetModule);
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(first);
    expect(db.inserted).toBe(1);
  });

  it('makes a new copy in the next slot after the user deleted theirs', async () => {
    db.rows = [{ _id: slot(0), fileName: sheetModule.sheet.name, deletedAt: new Date() }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(1));
    expect(db.inserted).toBe(1);
  });

  it('skips a slot whose copy the user renamed, and leaves that copy alone', async () => {
    db.rows = [{ _id: slot(0), fileName: 'my-fixture.csv' }];
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(1));
    expect(db.rows.find(row => row._id === slot(0))?.deletedAt).toBeUndefined();
  });

  it('moves past a full window of used slots', async () => {
    db.rows = Array.from({ length: 32 }, (_, n) => ({
      _id: slot(n),
      fileName: sheetModule.sheet.name,
      deletedAt: new Date(),
    }));
    expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe(slot(32));
  });

  it('gives up on an error that is not a lost key', async () => {
    createFabFile.mockRejectedValue(new Error('quota'));
    await expect(ensureTutorialSheet(CONFIG, req, sheetModule)).rejects.toThrow('quota');
  });

  describe('a fresh run (toTop)', () => {
    const DAY_AGO = new Date(Date.now() - 86_400_000);
    const MINUTE_AGO = new Date(Date.now() - 60_000);
    const newestFirst = () =>
      [...db.rows]
        .filter(row => !row.deletedAt)
        .sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0))
        .map(row => row._id);

    it("lifts the kept copy above the user's newer namesake, reissuing and deleting nothing", async () => {
      db.rows = [
        { _id: 'f1', fileName: sheetModule.sheet.name, createdAt: DAY_AGO },
        { _id: 'u9', fileName: sheetModule.sheet.name, tags: [], createdAt: MINUTE_AGO },
      ];
      expect(await ensureTutorialSheet(CONFIG, req, sheetModule, { toTop: true })).toBe('f1');
      expect(db.restamps).toEqual([{ filter: { _id: 'f1', userId: 'u1' }, options: { overwriteImmutable: true } }]);
      expect(newestFirst()[0]).toBe('f1');
      expect(createFabFile).not.toHaveBeenCalled();
      expect(deleteFabFile).not.toHaveBeenCalled();
      // The user's own file is theirs and stays as it was.
      expect(db.rows.find(row => row._id === 'u9')).toMatchObject({ createdAt: MINUTE_AGO });
    });

    it('does not restamp a copy it has just made', async () => {
      expect(await ensureTutorialSheet(CONFIG, req, sheetModule, { toTop: true })).toBe(slot(0));
      expect(db.restamps).toEqual([]);
    });

    it('still returns the copy when the restamp fails', async () => {
      db.rows = [{ _id: 'f1', fileName: sheetModule.sheet.name, createdAt: DAY_AGO }];
      db.restampFails = true;
      expect(await ensureTutorialSheet(CONFIG, req, sheetModule, { toTop: true })).toBe('f1');
      expect(req.logger.warn).toHaveBeenCalledWith(
        'Could not move the tutorial sheet to the top of Recent',
        expect.objectContaining({ fileId: 'f1' })
      );
    });

    it('leaves the copy where it is on a call that is not a fresh run', async () => {
      db.rows = [{ _id: 'f1', fileName: sheetModule.sheet.name, createdAt: DAY_AGO }];
      expect(await ensureTutorialSheet(CONFIG, req, sheetModule)).toBe('f1');
      expect(db.restamps).toEqual([]);
    });
  });
});
