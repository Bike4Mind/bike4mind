import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeBatchDocument } from '@bike4mind/common';

import { applyTaxonomySuggestions } from './applyTaxonomySuggestions';
import { setDataLakeFileTags } from './setDataLakeFileTags';

/**
 * Parity between the two CALLER-AUTHORED tag-write doors on the lake-prefix gate.
 *
 * They used to disagree (#2398): `setDataLakeFileTags` ran the whole `decideStampPrefix` gate
 * while `applyTaxonomySuggestions` checked only the static-registry collision and wrote tags
 * anyway for the other three reasons - so the same lake could accept a batch "Apply Tags" while
 * refusing a single-file tag edit. The doors share no code path other than the gate itself, which
 * is exactly why this belongs in its own file: neither door's own suite can see the other's answer.
 *
 * The assertion is on the MESSAGE, not just on "both threw". Two doors refusing the same lake for
 * different stated reasons is the confusing half of the bug, and the message is the only thing the
 * curator ever sees.
 */

type LakeFixture = {
  id: string;
  name: string;
  datalakeTag: string;
  fileTagPrefix: string;
  createdByUserId: string;
  status?: string;
};

const LAKE_ID = 'lake1';

/** Same creator as the lake under test, and `lk:sub:` sits under its `lk:` - a live clash. */
const PREFIX_OVERLAP_LAKE: LakeFixture = {
  id: 'lake2',
  name: 'Lake Two',
  datalakeTag: 'datalake:lake2',
  fileTagPrefix: 'lk:sub:',
  createdByUserId: 'owner',
};

const admin = { userId: 'root', isAdmin: true };

const lakeFixture = (fileTagPrefix: string): LakeFixture => ({
  id: LAKE_ID,
  name: 'Lake One',
  datalakeTag: 'datalake:lake1',
  fileTagPrefix,
  createdByUserId: 'owner',
  status: 'active',
});

/**
 * Serves `findCollidingPrefixLakes`' `$or` scope query. `overlapLookupFails` is the
 * `overlapCheckFailed` path - a diagnostic read that dies rather than returning a clash.
 */
const makeDataLakesAdapter = (lakes: LakeFixture[], overlapLookupFails: boolean) => ({
  findById: vi.fn().mockImplementation(async (id: string) => lakes.find(l => l.id === id) ?? null),
  findByDatalakeTag: vi.fn().mockResolvedValue(null),
  find: vi
    .fn()
    .mockImplementation(async () =>
      overlapLookupFails ? Promise.reject(new Error('overlap lookup unavailable')) : lakes
    ),
  setStats: vi.fn().mockResolvedValue(undefined),
  activateIfDraft: vi.fn().mockResolvedValue(false),
});

const grantsAdapter = () => ({
  listByLake: vi.fn().mockResolvedValue([]),
  listActiveByLakes: vi.fn().mockResolvedValue([]),
});

/** The single-file door: refuses at the gate, so nothing past the lake read is exercised. */
const singleFileDoorRefusal = async (lakes: LakeFixture[], overlapLookupFails: boolean): Promise<string> => {
  const db = {
    dataLakes: makeDataLakesAdapter(lakes, overlapLookupFails),
    dataLakeAccessGrants: grantsAdapter(),
    fabFiles: {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] }),
      pushTagsByFabFileId: vi.fn(),
      pullTagsByFabFileId: vi.fn(),
      computeDataLakeStats: vi.fn(),
    },
    adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
  };

  const error = await setDataLakeFileTags(admin, LAKE_ID, 'f1', ['lk:x'], {
    db: db as never,
    logger: { warn: vi.fn(), log: vi.fn() },
  }).then(
    () => null,
    (err: Error) => err
  );
  expect(error, 'setDataLakeFileTags accepted a prefix the gate refuses').not.toBeNull();
  return error!.message;
};

/** The batch door: same gate, ahead of the guarded 'ready' -> 'applying' claim. */
const batchDoorRefusal = async (lakes: LakeFixture[], overlapLookupFails: boolean): Promise<string> => {
  const batches = {
    findById: vi.fn().mockResolvedValue({
      id: 'b1',
      dataLakeId: LAKE_ID,
      taxonomyStatus: 'ready',
      taxonomySuggestions: { tags: [], fileAssignments: [] },
    } as unknown as IDataLakeBatchDocument),
    setTaxonomyStatusIfActive: vi.fn().mockResolvedValue(null),
  };
  const db = {
    dataLakes: makeDataLakesAdapter(lakes, overlapLookupFails),
    dataLakeAccessGrants: grantsAdapter(),
    batches,
    fabFiles: { findByBatchId: vi.fn().mockResolvedValue([]), bulkUpdateTags: vi.fn().mockResolvedValue(0) },
  };

  const error = await applyTaxonomySuggestions(admin, 'b1', [], {
    db: db as never,
    logger: { warn: vi.fn() },
  }).then(
    () => null,
    (err: Error) => err
  );
  expect(error, 'applyTaxonomySuggestions accepted a prefix the gate refuses').not.toBeNull();
  // The claim has to stay untouched: a prefix refusal that ran after it would strand the batch in
  // 'applying' until the stuck-job reconciler noticed.
  expect(batches.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  return error!.message;
};

describe('lake tag-prefix gate parity across the caller-authored write doors', () => {
  it.each([
    ['unusable-prefix', [lakeFixture('lk')], /unusable-prefix/],
    ['reserved-namespace', [lakeFixture('datalake:lk:')], /reserved-namespace/],
    ['registry-prefix-overlap', [lakeFixture('opti:')], /registry-prefix-overlap/],
    ['prefix-overlap', [lakeFixture('lk:'), PREFIX_OVERLAP_LAKE], /prefix-overlap.*Lake Two/],
  ] as const)('refuses %s identically at both doors', async (_reason, lakes, expected) => {
    const singleFile = await singleFileDoorRefusal([...lakes], false);
    const batch = await batchDoorRefusal([...lakes], false);

    expect(singleFile).toMatch(expected);
    expect(batch).toBe(singleFile);
  });

  // Not one of the four refusal reasons: a PERMITTED decision whose overlap lookup failed. Both
  // doors mint caller-authored names, so both fail closed rather than write across an overlap
  // neither could rule out. The live reconciler and the backfill migration each choose separately.
  it('refuses an unverifiable overlap identically at both doors', async () => {
    const singleFile = await singleFileDoorRefusal([lakeFixture('lk:')], true);
    const batch = await batchDoorRefusal([lakeFixture('lk:')], true);

    expect(singleFile).toMatch(/could not verify/i);
    expect(batch).toBe(singleFile);
  });

  // The gate is a property of the LAKE, so a lake it permits must not be refused by either door -
  // otherwise the parity above could be satisfied by two doors that refuse everything.
  it('permits a clean prefix at both doors', async () => {
    const lakes = [lakeFixture('lk:')];

    await expect(
      applyTaxonomySuggestions(admin, 'b1', [], {
        db: {
          dataLakes: makeDataLakesAdapter(lakes, false),
          dataLakeAccessGrants: grantsAdapter(),
          batches: {
            findById: vi.fn().mockResolvedValue({
              id: 'b1',
              dataLakeId: LAKE_ID,
              taxonomyStatus: 'ready',
              taxonomySuggestions: { tags: [], fileAssignments: [] },
            } as unknown as IDataLakeBatchDocument),
            setTaxonomyStatusIfActive: vi
              .fn()
              .mockResolvedValue({ id: 'b1', taxonomyStatus: 'applying' } as unknown as IDataLakeBatchDocument),
          },
          fabFiles: { findByBatchId: vi.fn().mockResolvedValue([]), bulkUpdateTags: vi.fn().mockResolvedValue(0) },
        } as never,
        logger: { warn: vi.fn() },
      })
    ).resolves.toMatchObject({ success: true });

    const singleFileDb = {
      dataLakes: makeDataLakesAdapter(lakes, false),
      dataLakeAccessGrants: grantsAdapter(),
      fabFiles: {
        findById: vi
          .fn()
          .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake1', strength: 1 }] }),
        pushTagsByFabFileId: vi.fn().mockResolvedValue(1),
        pullTagsByFabFileId: vi.fn().mockResolvedValue(0),
        computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10, totalChunkedChars: 0 }),
      },
      adminSettings: { findAll: vi.fn().mockResolvedValue([]), findBySettingNames: vi.fn().mockResolvedValue([]) },
    };

    await expect(
      setDataLakeFileTags(admin, LAKE_ID, 'f1', ['lk:x'], {
        db: singleFileDb as never,
        logger: { warn: vi.fn(), log: vi.fn() },
      })
    ).resolves.toBeDefined();
  });
});
