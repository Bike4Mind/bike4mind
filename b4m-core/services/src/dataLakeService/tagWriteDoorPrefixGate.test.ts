import { describe, it, expect, vi } from 'vitest';
import type {
  IDataLakeAccessGrantRepository,
  IDataLakeBatchDocument,
  IDataLakeDocument,
  IDataLakeRepository,
  IFabFileDocument,
  IFabFileRepository,
} from '@bike4mind/common';

import { applyTaxonomySuggestions } from './applyTaxonomySuggestions';
import { setDataLakeFileTags } from './setDataLakeFileTags';
import { stampRefusalMessage, UNVERIFIED_PREFIX_OVERLAP_REFUSAL } from './fallbackLakeTags';

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
 *
 * Each adapter bag below is typed as the door's OWN parameter type rather than cast to `never`, so
 * the `find` this PR added to `ApplyTaxonomySuggestionsAdapters` is a compile-time requirement here
 * too, and a bag that stops satisfying a door fails the build instead of passing silently. The
 * remaining casts are confined to the repository METHOD sets and the fixture DOCUMENTS: the real
 * interfaces return hydrated Mongoose documents (~40 fields plus instance methods) that these two
 * doors read a handful of fields from, and the neighbouring door suites use the same convention.
 */

type ApplyTaxonomyAdapters = Parameters<typeof applyTaxonomySuggestions>[3];
type SetFileTagsAdapters = Parameters<typeof setDataLakeFileTags>[4];

type DataLakesSlice = Pick<
  IDataLakeRepository,
  'findById' | 'findByDatalakeTag' | 'find' | 'setStats' | 'activateIfDraft'
>;
type FabFilesSlice = Pick<
  IFabFileRepository,
  'findById' | 'pushTagsByFabFileId' | 'pullTagsByFabFileId' | 'computeDataLakeStats'
>;
type GrantsSlice = Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'listActiveByLakes'>;

type LakeFixture = Pick<
  IDataLakeDocument,
  'id' | 'name' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId' | 'status'
>;

const LAKE_ID = 'lake1';

/** Same creator as the lake under test, and `lk:sub:` sits under its `lk:` - a live clash. */
const PREFIX_OVERLAP_LAKE: LakeFixture = {
  id: 'lake2',
  name: 'Lake Two',
  datalakeTag: 'datalake:lake2',
  fileTagPrefix: 'lk:sub:',
  createdByUserId: 'owner',
  status: 'active',
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

// Cast: the prefix gate reads six fields off the lake, while the real type is a hydrated document.
const asLakeDoc = (lake: LakeFixture) => lake as IDataLakeDocument;

/**
 * `overlapLookupFails` is the `overlapCheckFailed` path - a diagnostic read that dies rather than
 * returning a clash.
 */
const makeDataLakesAdapter = (lakes: LakeFixture[], overlapLookupFails = false): DataLakesSlice =>
  ({
    findById: vi.fn(async (id: string) => {
      const found = lakes.find(l => l.id === id);
      return found ? asLakeDoc(found) : null;
    }),
    findByDatalakeTag: vi.fn(async () => null),
    find: vi.fn(async () => {
      if (overlapLookupFails) throw new Error('overlap lookup unavailable');
      return lakes.map(asLakeDoc);
    }),
    setStats: vi.fn(async () => undefined),
    activateIfDraft: vi.fn(async () => false),
  }) as unknown as DataLakesSlice;

const makeGrantsAdapter = (): GrantsSlice =>
  ({
    listByLake: vi.fn(async () => []),
    listActiveByLakes: vi.fn(async () => []),
  }) as unknown as GrantsSlice;

const MEMBER_FILE = {
  id: 'f1',
  userId: 'owner',
  tags: [{ name: 'datalake:lake1', strength: 1 }],
} as unknown as IFabFileDocument;

const makeFabFilesAdapter = (): FabFilesSlice =>
  ({
    findById: vi.fn(async () => MEMBER_FILE),
    pushTagsByFabFileId: vi.fn(async () => 1),
    pullTagsByFabFileId: vi.fn(async () => 0),
    computeDataLakeStats: vi.fn(async () => ({ fileCount: 1, totalSizeBytes: 10, totalChunkedChars: 0 })),
  }) as unknown as FabFilesSlice;

const READY_BATCH = {
  id: 'b1',
  dataLakeId: LAKE_ID,
  taxonomyStatus: 'ready',
  taxonomySuggestions: { tags: [], fileAssignments: [] },
} as unknown as IDataLakeBatchDocument;

const singleFileAdapters = (lakes: LakeFixture[], overlapLookupFails = false): SetFileTagsAdapters => ({
  db: {
    dataLakes: makeDataLakesAdapter(lakes, overlapLookupFails),
    dataLakeAccessGrants: makeGrantsAdapter(),
    fabFiles: makeFabFilesAdapter(),
    adminSettings: { findAll: vi.fn(async () => []), findBySettingNames: vi.fn(async () => []) },
  },
  logger: { warn: vi.fn(), log: vi.fn() },
});

const batchAdapters = (
  lakes: LakeFixture[],
  overlapLookupFails = false,
  claimResult: IDataLakeBatchDocument | null = null
): ApplyTaxonomyAdapters => ({
  db: {
    dataLakes: makeDataLakesAdapter(lakes, overlapLookupFails),
    dataLakeAccessGrants: makeGrantsAdapter(),
    batches: {
      findById: vi.fn(async () => READY_BATCH),
      setTaxonomyStatusIfActive: vi.fn(async () => claimResult),
    },
    fabFiles: { findByBatchId: vi.fn(async () => []), bulkUpdateTags: vi.fn(async () => 0) },
  },
  logger: { warn: vi.fn() },
});

/** The single-file door: refuses at the gate, so nothing past the lake read is exercised. */
const singleFileDoorRefusal = async (lakes: LakeFixture[], overlapLookupFails = false): Promise<string> => {
  const error = await setDataLakeFileTags(
    admin,
    LAKE_ID,
    'f1',
    ['lk:x'],
    singleFileAdapters(lakes, overlapLookupFails)
  ).then(
    () => null,
    (err: Error) => err
  );
  expect(error, 'setDataLakeFileTags accepted a prefix the gate refuses').not.toBeNull();
  return error!.message;
};

/** The batch door: same gate, ahead of the guarded 'ready' -> 'applying' claim. */
const batchDoorRefusal = async (lakes: LakeFixture[], overlapLookupFails = false): Promise<string> => {
  const adapters = batchAdapters(lakes, overlapLookupFails);
  const error = await applyTaxonomySuggestions(admin, 'b1', [], adapters).then(
    () => null,
    (err: Error) => err
  );
  expect(error, 'applyTaxonomySuggestions accepted a prefix the gate refuses').not.toBeNull();
  // The claim has to stay untouched: a prefix refusal that ran after it would strand the batch in
  // 'applying' until the stuck-job reconciler noticed.
  expect(adapters.db.batches.setTaxonomyStatusIfActive).not.toHaveBeenCalled();
  return error!.message;
};

describe('lake tag-prefix gate parity across the caller-authored write doors', () => {
  it.each([
    ['unusable-prefix', [lakeFixture('lk')], /unusable-prefix/],
    ['reserved-namespace', [lakeFixture('datalake:lk:')], /reserved-namespace/],
    ['registry-prefix-overlap', [lakeFixture('opti:')], /registry-prefix-overlap/],
    ['prefix-overlap', [lakeFixture('lk:'), PREFIX_OVERLAP_LAKE], /prefix-overlap.*Lake Two/],
  ] as const)('refuses %s identically at both doors', async (_reason, lakes, expected) => {
    const singleFile = await singleFileDoorRefusal([...lakes]);
    const batch = await batchDoorRefusal([...lakes]);

    expect(singleFile).toMatch(expected);
    expect(batch).toBe(singleFile);
  });

  // Not one of the four refusal reasons: a PERMITTED decision whose overlap lookup failed. Both
  // doors mint caller-authored names, so both fail closed rather than write across an overlap
  // neither could rule out. The live reconciler and the backfill migration each choose separately.
  it('refuses an unverifiable overlap identically at both doors', async () => {
    const singleFile = await singleFileDoorRefusal([lakeFixture('lk:')], true);
    const batch = await batchDoorRefusal([lakeFixture('lk:')], true);

    expect(singleFile).toBe(UNVERIFIED_PREFIX_OVERLAP_REFUSAL);
    expect(batch).toBe(singleFile);
  });

  // The gate is a property of the LAKE, so a lake it permits must not be refused by either door -
  // otherwise the parity above could be satisfied by two doors that refuse everything.
  it('permits a clean prefix at both doors', async () => {
    const lakes = [lakeFixture('lk:')];

    await expect(
      applyTaxonomySuggestions(admin, 'b1', [], batchAdapters(lakes, false, READY_BATCH))
    ).resolves.toMatchObject({ success: true });

    await expect(setDataLakeFileTags(admin, LAKE_ID, 'f1', ['lk:x'], singleFileAdapters(lakes))).resolves.toBeDefined();
  });
});

/**
 * The refusal COPY, pinned by content rather than by shape.
 *
 * Without these, gutting every explanation to the empty string would leave the parity suite above
 * green - it only compares the two doors to each other. These messages are what a curator reads
 * and what a support ticket is grepped for, so each case asserts the two halves that carry
 * meaning: the plain-language explanation, and the reason slug that maps back to a branch of the
 * gate.
 */
describe('stampRefusalMessage copy', () => {
  it.each([
    ['unusable-prefix', 'no usable tag prefix'],
    ['reserved-namespace', 'reserved datalake: namespace'],
    ['prefix-overlap', 'overlaps another data lake'],
    ['registry-prefix-overlap', 'overlaps a built-in data lake'],
  ] as const)('explains %s in plain language and names the reason', (reason, explanation) => {
    const message = stampRefusalMessage({ stamp: false, reason });

    expect(message).toContain("This lake's tag prefix cannot be used right now");
    expect(message).toContain(explanation);
    expect(message).toContain(reason);
  });

  it('appends the colliding lakes when the gate names them', () => {
    const message = stampRefusalMessage({
      stamp: false,
      reason: 'prefix-overlap',
      detail: '"Lake Two" (lk:sub:)',
    });

    expect(message).toContain('prefix-overlap: "Lake Two" (lk:sub:)');
  });

  it('tells the caller to retry when the overlap check itself could not run', () => {
    expect(UNVERIFIED_PREFIX_OVERLAP_REFUSAL).toContain('Could not verify');
    expect(UNVERIFIED_PREFIX_OVERLAP_REFUSAL).toContain('try again');
  });
});
