import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccessContext, IDataLakeDocument, IDataLakeBatchDocument } from '@bike4mind/common';
import { canAccessLake, assertLakeAccess } from './assertLakeAccess';
import { canManageLake, assertLakeWriteAccess, assertCanWriteDataLakeTags } from './authorizeLakeWrite';
import { createDataLake } from './createDataLake';
import { unarchiveDataLake } from './unarchiveDataLake';
import { restoreDeletedDataLake } from './restoreDeletedDataLake';
import { cleanupDeletedDataLake } from './cleanupDeletedDataLake';
import { removeFileFromDataLake } from './removeFileFromDataLake';
import { setLakeVisibility } from './setLakeVisibility';
import { reconcileStuckBatches, DEFAULT_STUCK_BATCH_TIMEOUT_MS } from './reconcileStuckBatches';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'someone',
  isAdmin: false,
  userTags: [],
  organizationId: undefined,
  ...overrides,
});

describe('canAccessLake — the single access gate rule', () => {
  it('grants the owner', () => {
    expect(canAccessLake(lake(), ctx({ userId: 'owner' }))).toBe(true);
  });

  it('grants an admin', () => {
    expect(canAccessLake(lake({ requiredUserTag: 'secret', organizationId: 'orgA' }), ctx({ isAdmin: true }))).toBe(
      true
    );
  });

  it('grants a non-owner who satisfies BOTH org and tag', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', userTags: ['opti'] }))).toBe(true);
  });

  it('DENIES a tag-holder in a DIFFERENT org (org is a hard prerequisite, not a flat OR)', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgB', userTags: ['opti'] }))).toBe(false);
  });

  it('DENIES a same-org user missing the required tag', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', userTags: ['other'] }))).toBe(false);
  });

  it('Private-by-default: a gateless, org-less lake is owner/admin-only', () => {
    const priv = lake(); // no org, no requiredUserTag, no requiredEntitlement
    // Owner and admin still reach it.
    expect(canAccessLake(priv, ctx({ userId: 'owner' }))).toBe(true);
    expect(canAccessLake(priv, ctx({ isAdmin: true }))).toBe(true);
    // Every other caller is denied - this is the single-lake gate matching the rule the
    // collection paths enforce, so a guessed-slug private lake can't be reached.
    expect(canAccessLake(priv, ctx())).toBe(false);
    expect(canAccessLake(priv, ctx({ organizationId: 'orgA', userTags: ['anything'] }))).toBe(false);
  });

  it('Public: an isPublic lake is readable by any caller, cross-org, bypassing Private-by-default', () => {
    // isPublic with NO org and NO gate would be Private-by-default; the public arm must run
    // first so it is readable by everyone, in any org, regardless of tags/keys.
    const pub = lake({ isPublic: true, createdByUserId: 'alice' });
    expect(canAccessLake(pub, ctx({ userId: 'stranger' }))).toBe(true);
    expect(canAccessLake(pub, ctx({ userId: 'stranger', organizationId: 'orgB' }))).toBe(true);
  });

  it('Public + a (post-publish) gate still enforces the gate — defense in depth', () => {
    // Publishing a gated lake is refused by setLakeVisibility, but if a gate is added AFTER
    // publishing, the read gate must still hold: only a key-holder reads it, and org is bypassed.
    const pubGated = lake({ isPublic: true, requiredEntitlement: 'product:pro', createdByUserId: 'alice' });
    expect(canAccessLake(pubGated, ctx({ userId: 'stranger' }))).toBe(false);
    expect(canAccessLake(pubGated, ctx({ userId: 'stranger', entitlementKeys: ['product:pro'] }))).toBe(true);
    // Cross-org key-holder still reads it: public bypasses the org prerequisite.
    expect(
      canAccessLake(pubGated, ctx({ userId: 'stranger', organizationId: 'orgB', entitlementKeys: ['product:pro'] }))
    ).toBe(true);
  });

  it('an entitlement-gated lake is NOT swept up as private — the private rule keys off field PRESENCE', () => {
    // The private-by-default rule denies only lakes with NO org and NO gate. A lake declaring
    // requiredEntitlement has a gate, so the private rule never touches it: a key-holder is
    // granted, while a non-holder is denied by the entitlement gate (lakeMatchesAccess) - NOT
    // by the private rule.
    const gated = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(gated, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
    expect(canAccessLake(gated, ctx())).toBe(false);
  });
});

// Generic placeholder keys (product:pro / medlib) - no product literals, to keep this core
// test boundary-clean (the same convention as getAccessibleDataLakes' tests).
describe('canAccessLake — entitlement-aware any-of (tag-retirement)', () => {
  it('grants a non-owner via requiredEntitlement (no tag held — the tag-less subscriber)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
  });

  it('grants via EITHER the required tag OR the required entitlement (any-of)', () => {
    const l = lake({ requiredUserTag: 'medlib', requiredEntitlement: 'product:pro' });
    // entitlement only
    expect(canAccessLake(l, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
    // tag only
    expect(canAccessLake(l, ctx({ userTags: ['medlib'] }))).toBe(true);
  });

  it('matches the required entitlement case-insensitively (normalized)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ entitlementKeys: ['Product:Pro'] }))).toBe(true);
  });

  it('treats a lake declaring ONLY requiredEntitlement as NOT public (gated by the key)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx())).toBe(false); // no tag, no key
    expect(canAccessLake(l, ctx({ entitlementKeys: ['other:pro'] }))).toBe(false);
  });

  it('DENIES an entitlement-holder in a DIFFERENT org (org stays a hard prerequisite)', () => {
    const l = lake({ organizationId: 'orgA', requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgB', entitlementKeys: ['product:pro'] }))).toBe(false);
  });

  it('grants a same-org entitlement-holder when the lake is org-scoped', () => {
    const l = lake({ organizationId: 'orgA', requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', entitlementKeys: ['product:pro'] }))).toBe(true);
  });

  it('no-tag-only-access: holding ONLY the bare tag (not the namespaced :pro key) is denied a :pro-gated lake', () => {
    // The retired-tag invariant, generically: a lake gated by `product:pro` is NOT reachable by
    // a user who holds only the bare `product` tag/key (the 1:1 passthrough) without `product:pro`.
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ userTags: ['product'], entitlementKeys: ['product'] }))).toBe(false);
  });
});

describe('assertLakeAccess — not-found-style denial', () => {
  it('throws a not-found-style error for a denied non-member (does not disclose existence)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeAccess('lake1', ctx({ organizationId: 'orgB', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/not found/i);
  });

  it('returns the lake on grant', async () => {
    const l = lake();
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertLakeAccess('lake1', ctx({ userId: 'owner' }), { db })).resolves.toBe(l);
  });
});

describe('canManageLake — the single write/manage rule (creator or admin)', () => {
  it('grants the creator', () => {
    expect(canManageLake(lake({ createdByUserId: 'owner' }), { userId: 'owner', isAdmin: false })).toBe(true);
  });

  it('grants any admin (even a non-creator)', () => {
    expect(canManageLake(lake({ createdByUserId: 'owner' }), { userId: 'other', isAdmin: true })).toBe(true);
  });

  it('denies a non-creator non-admin — even one who can READ via a tag grant', () => {
    // The read gate (canAccessLake) would grant this caller, but write must not.
    const gated = lake({ createdByUserId: 'owner', requiredUserTag: 'Opti' });
    expect(canAccessLake(gated, ctx({ userId: 'reader', userTags: ['opti'] }))).toBe(true);
    expect(canManageLake(gated, { userId: 'reader', isAdmin: false })).toBe(false);
  });
});

describe('assertLakeWriteAccess — read-then-manage gate for the upload doors', () => {
  it('returns the lake for the creator', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertLakeWriteAccess('lake1', ctx({ userId: 'owner' }), { db })).resolves.toBe(l);
  });

  it('not-found for a caller who cannot even read the lake (no existence leak)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti', createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeWriteAccess('lake1', ctx({ userId: 'x', organizationId: 'orgB', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/not found/i);
  });

  it('manage-denied for a reader who is not the creator (the manage-access asymmetry)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti', createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeWriteAccess('lake1', ctx({ userId: 'reader', organizationId: 'orgA', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/creator/i);
  });
});

describe('assertCanWriteDataLakeTags — gate on the file-tag write paths', () => {
  const makeDb = (found: IDataLakeDocument | null) => ({
    dataLakes: { findByDatalakeTag: vi.fn().mockResolvedValue(found) },
  });

  it('ignores non-meta tags entirely (no lookup, no throw)', async () => {
    const db = makeDb(null);
    await expect(
      assertCanWriteDataLakeTags({ userId: 'anyone', isAdmin: false }, ['acme:sales', 'notes'], { db })
    ).resolves.toBeUndefined();
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('allows the creator to apply the lake meta-tag', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:lake'], { db })
    ).resolves.toBeUndefined();
  });

  it('allows an admin to apply the lake meta-tag', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'other', isAdmin: true }, ['datalake:lake'], { db })
    ).resolves.toBeUndefined();
  });

  it('rejects a read-only member injecting into a lake they do not own', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'reader', isAdmin: false }, ['datalake:lake'], { db })
    ).rejects.toThrow(/creator/i);
  });

  it('rejects a meta-tag that resolves to no lake (forged/stale tag)', async () => {
    const db = makeDb(null);
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:ghost'], { db })
    ).rejects.toThrow(/creator/i);
  });

  it('tolerates malformed (non-string) tag entries — fails closed as 400, never a TypeError', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    // A raw, un-validated payload with null/number/object entries must not crash the guard.
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, [null, undefined, 42, {}, 'notes'] as unknown[], {
        db,
      })
    ).resolves.toBeUndefined();
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('normalizes a mixed-case meta-tag to its canonical (lowercase) lake key before lookup', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['DataLake:Lake'], { db });
    expect(db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith('datalake:lake');
  });

  it('rejects when ANY meta-tag among several is unauthorized (mixed batch)', async () => {
    const db = {
      dataLakes: {
        findByDatalakeTag: vi.fn(async (tag: string) =>
          tag === 'datalake:mine'
            ? lake({ createdByUserId: 'owner', datalakeTag: 'datalake:mine' })
            : lake({ createdByUserId: 'someone-else', datalakeTag: 'datalake:theirs' })
        ),
      },
    };
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:mine', 'datalake:theirs'], { db })
    ).rejects.toThrow(/creator/i);
  });
});

describe('createDataLake', () => {
  it('creates the lake in DRAFT status (draft -> active is implicit on first batch)', async () => {
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    const db = { dataLakes: { create, find: vi.fn().mockResolvedValue([]) } };
    await createDataLake('owner', { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' }, { db });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('scopes the meta-tag by org and disambiguates a slug collision deterministically', async () => {
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    // First slug taken, second free.
    const find = vi.fn().mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    const db = { dataLakes: { create, find } };
    // org comes from the principal (4th arg), never the request body.
    await createDataLake('owner', { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' }, { db }, 'orgA');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xy-1', datalakeTag: 'datalake:orgA:xy-1' }));
  });
});

describe('unarchiveDataLake — dedup pass (live re-upload wins)', () => {
  it('discards archived duplicates and restores the rest', async () => {
    const archived = [
      { id: 'a1', contentHash: 'h1' },
      { id: 'a2', contentHash: 'h2' },
    ];
    const fabFiles = {
      findArchivedByDataLakeTag: vi.fn().mockResolvedValue(archived),
      // a live file with hash h1 exists (re-uploaded while archived) -> a1 is a dup.
      findByContentHashesInDataLake: vi.fn().mockResolvedValue([{ id: 'live1', contentHash: 'h1' }]),
      unarchiveByDataLakeTag: vi.fn().mockResolvedValue(1),
      deleteManyInIds: vi.fn().mockResolvedValue(undefined),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 }),
    };
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'archived' })),
      update: vi.fn().mockResolvedValue(lake()),
      setStats: vi.fn().mockResolvedValue(lake()),
    };
    const result = await unarchiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
      db: { dataLakes, fabFiles },
    });
    expect(fabFiles.deleteManyInIds).toHaveBeenCalledWith(['a1']);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.restoredCount).toBe(1);
  });
});

describe('restoreDeletedDataLake — deleted→active with dedup', () => {
  it('rejects a lake that is not soft-deleted', async () => {
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'active' })),
      update: vi.fn(),
      setStats: vi.fn(),
    };
    const fabFiles = {
      findDeletedByDataLakeTag: vi.fn(),
      findByContentHashesInDataLake: vi.fn(),
      undeleteByDataLakeTag: vi.fn(),
      computeDataLakeStats: vi.fn(),
    };
    await expect(
      restoreDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { db: { dataLakes, fabFiles } })
    ).rejects.toThrow(/'active' status/i);
  });

  it('un-deletes non-duplicates and excludes live-re-upload duplicates', async () => {
    const deleted = [
      { id: 'd1', contentHash: 'h1' },
      { id: 'd2', contentHash: 'h2' },
    ];
    const fabFiles = {
      findDeletedByDataLakeTag: vi.fn().mockResolvedValue(deleted),
      // a live file with hash h1 exists -> d1 is a dup and must be excluded from un-delete.
      findByContentHashesInDataLake: vi.fn().mockResolvedValue([{ id: 'live1', contentHash: 'h1' }]),
      undeleteByDataLakeTag: vi.fn().mockResolvedValue(1),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 }),
    };
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'deleted' })),
      update: vi.fn().mockResolvedValue(lake()),
      setStats: vi.fn().mockResolvedValue(lake()),
    };
    const result = await restoreDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
      db: { dataLakes, fabFiles },
    });
    expect(fabFiles.undeleteByDataLakeTag).toHaveBeenCalledWith('datalake:lake', ['d1']);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.restoredCount).toBe(1);
  });
});

describe('cleanupDeletedDataLake — phase 2 sweep', () => {
  const makeAdapters = (status: IDataLakeDocument['status']) => ({
    db: {
      dataLakes: {
        findById: vi.fn().mockResolvedValue(lake({ status })),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      batches: { find: vi.fn().mockResolvedValue([{ id: 'b1' }]), delete: vi.fn().mockResolvedValue(undefined) },
      fabFiles: {
        findIdsByDataLakeTag: vi.fn().mockResolvedValue(['f1', 'f2']),
        hardDeleteByDataLakeTag: vi.fn().mockResolvedValue(['f1', 'f2']),
      },
      fabFileChunks: { deleteManyByFabFileId: vi.fn().mockResolvedValue(undefined) },
    },
  });

  it('refuses to purge a lake that is not soft-deleted', async () => {
    const adapters = makeAdapters('active');
    await expect(cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters)).rejects.toThrow(
      /soft-deleted/i
    );
  });

  it('purges chunks, files, batches, then the lake when soft-deleted', async () => {
    const adapters = makeAdapters('deleted');
    await cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters);
    expect(adapters.db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledTimes(2);
    expect(adapters.db.fabFiles.hardDeleteByDataLakeTag).toHaveBeenCalled();
    expect(adapters.db.batches.delete).toHaveBeenCalledWith('b1');
    expect(adapters.db.dataLakes.delete).toHaveBeenCalledWith('lake1');
  });

  it('is idempotent: already-gone lake is a no-op success', async () => {
    const adapters = makeAdapters('deleted');
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(null);
    await expect(
      cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters)
    ).resolves.toBeUndefined();
    expect(adapters.db.dataLakes.delete).not.toHaveBeenCalled();
  });
});

describe('reconcileStuckBatches — guarded read-time reconciliation', () => {
  const batch = (overrides: Partial<IDataLakeBatchDocument> = {}): IDataLakeBatchDocument =>
    ({
      id: 'b1',
      dataLakeId: 'lake1',
      status: 'processing',
      updatedAt: new Date(0),
      ...overrides,
    }) as IDataLakeBatchDocument;

  const makeDb = () => ({
    dataLakes: { findById: vi.fn().mockResolvedValue(lake()), setStats: vi.fn() },
    batches: { markTerminalIfActive: vi.fn().mockResolvedValue(batch({ status: 'completed_with_errors' })) },
    fabFiles: { computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }) },
  });
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });

  it('forces a stuck non-terminal batch terminal and recomputes stats', async () => {
    const now = DEFAULT_STUCK_BATCH_TIMEOUT_MS + 10_000;
    const forced = await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    expect(db.batches.markTerminalIfActive).toHaveBeenCalledWith('b1', 'completed_with_errors');
    expect(db.fabFiles.computeDataLakeStats).toHaveBeenCalled();
    expect(forced).toEqual(['b1']);
  });

  it('leaves a recently-updated batch alone', async () => {
    const recent = batch({ updatedAt: new Date(1000) });
    const now = 2000; // within timeout
    const forced = await reconcileStuckBatches([recent], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    expect(db.batches.markTerminalIfActive).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });

  it('does NOT recompute when the guarded transition is lost (a real increment finalized first)', async () => {
    db.batches.markTerminalIfActive = vi.fn().mockResolvedValue(null); // lost the guard
    const now = DEFAULT_STUCK_BATCH_TIMEOUT_MS + 10_000;
    const forced = await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    expect(db.fabFiles.computeDataLakeStats).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });
});

describe('removeFileFromDataLake — single-file removal', () => {
  // A file that belongs to this lake AND another lake, to prove removal is lake-scoped.
  const fileInLake = {
    id: 'f1',
    tags: [
      { name: 'datalake:lake', strength: 1 },
      { name: 'datalake:other', strength: 1 },
    ],
  };

  const makeAdapters = (file: unknown = fileInLake) => ({
    db: {
      dataLakes: { findById: vi.fn().mockResolvedValue(lake()), setStats: vi.fn() },
      fabFiles: {
        findById: vi.fn().mockResolvedValue(file),
        pullTagByFabFileId: vi.fn().mockResolvedValue(1),
        computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
      },
    },
  });

  it('atomically pulls only the lake tag (keeps other lakes), never soft-deletes, and recomputes stats (owner)', async () => {
    const adapters = makeAdapters();
    const result = await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // Lake-scoped + concurrency-safe: an atomic $pull of THIS lake's tag only - never a
    // whole-array rewrite (which could clobber a concurrent removal) and never a soft-delete.
    expect(adapters.db.fabFiles.pullTagByFabFileId).toHaveBeenCalledWith('f1', 'datalake:lake');
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalled();
    expect(result).toEqual({ success: true, fileCount: 0, totalSizeBytes: 0 });
  });

  it('removing the file from its ONLY lake still just pulls the tag — never cascade-deletes the file', async () => {
    // Guards the invariant that a file's existence is independent of any lake: even when this
    // is the last lake it belongs to, removal drops the tag and leaves the FabFile intact.
    const fileInOnlyThisLake = { id: 'f1', tags: [{ name: 'datalake:lake', strength: 1 }] };
    const adapters = makeAdapters(fileInOnlyThisLake);
    const result = await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // Same tag-pull path as the multi-lake case - the service has no cascade-delete branch,
    // so "last lake" is not special: the tag is pulled and the file is left to exist.
    expect(adapters.db.fabFiles.pullTagByFabFileId).toHaveBeenCalledWith('f1', 'datalake:lake');
    expect(result).toEqual({ success: true, fileCount: 0, totalSizeBytes: 0 });
  });

  it('allows an admin who is not the creator', async () => {
    const adapters = makeAdapters();
    await expect(
      removeFileFromDataLake({ userId: 'other', isAdmin: true }, 'lake1', 'f1', adapters as any)
    ).resolves.toMatchObject({ success: true });
  });

  it('rejects a non-creator non-admin (no teardown)', async () => {
    const adapters = makeAdapters();
    await expect(
      removeFileFromDataLake({ userId: 'intruder', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/creator/i);
    expect(adapters.db.fabFiles.pullTagByFabFileId).not.toHaveBeenCalled();
  });

  it('404s when the file does not carry the lake tag (not in this lake)', async () => {
    const adapters = makeAdapters({ id: 'f1', tags: [{ name: 'datalake:other', strength: 1 }] });
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagByFabFileId).not.toHaveBeenCalled();
  });

  it('404s when the lake does not exist', async () => {
    const adapters = makeAdapters();
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(null);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/Data lake not found/i);
  });
});

describe('setLakeVisibility — personal ↔ org promotion', () => {
  const makeDb = (existing: Partial<IDataLakeDocument> = {}, clashes: IDataLakeDocument[] = []) => ({
    dataLakes: {
      findById: vi.fn().mockResolvedValue(lake(existing)),
      find: vi.fn().mockResolvedValue(clashes),
      update: vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => lake(d)),
    },
  });

  it('promotes a personal lake to the actor’s org (org from principal, not the body)', async () => {
    const db = makeDb(); // existing lake is org-less (private)
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    expect(db.dataLakes.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1', organizationId: 'orgA' }));
  });

  it('demotes an org lake back to private by clearing organizationId (null, not undefined)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'private', {
      db,
    } as any);
    expect(db.dataLakes.update.mock.calls[0][0].organizationId).toBeNull();
  });

  it('rejects a non-creator non-admin', async () => {
    const db = makeDb();
    await expect(
      setLakeVisibility({ userId: 'intruder', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/creator/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('rejects promotion when the actor has no organization', async () => {
    const db = makeDb();
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/organization/i);
  });

  it('rejects when the target scope already has a lake with that slug (collision guard)', async () => {
    const db = makeDb({}, [lake({ id: 'other', slug: 'lake', organizationId: 'orgA' })]);
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/already exists/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('is a no-op when already in the requested visibility (no update)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('blocks a non-owner admin from PROMOTING (no cross-org steal into the admin’s org)', async () => {
    const db = makeDb(); // lake owned by 'owner'
    await expect(
      setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/owner/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('lets a non-owner admin DEMOTE a lake to private (removes scope, writes null — no steal)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'private', {
      db,
    } as any);
    expect(db.dataLakes.update.mock.calls[0][0].organizationId).toBeNull();
  });

  it('maps a TOCTOU duplicate-key (E11000) on write to the friendly collision error', async () => {
    const db = makeDb(); // find pre-check passes, but the write loses the race
    db.dataLakes.update = vi.fn().mockRejectedValue(Object.assign(new Error('E11000 dup key'), { code: 11000 }));
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/already exists/i);
  });

  it('publishes a private lake: sets isPublic=true and clears org (no slug-collision round-trip)', async () => {
    const db = makeDb(); // existing lake is org-less, not public
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'public', {
      db,
    } as any);
    // private -> public keeps the same (org-less) slug scope, so no collision query is needed.
    expect(db.dataLakes.find).not.toHaveBeenCalled();
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written.isPublic).toBe(true);
    expect(written.organizationId).toBeNull();
  });

  it('un-publishes: public -> private writes isPublic=false', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'private', {
      db,
    } as any);
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written.isPublic).toBe(false);
    expect(written.organizationId).toBeNull();
  });

  it('promoting to org clears any prior public flag (mutually exclusive tri-state)', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written).toMatchObject({ organizationId: 'orgA', isPublic: false });
  });

  it('refuses to publish a lake gated by a required tag (PHI/access-gate guardrail)', async () => {
    const db = makeDb({ requiredUserTag: 'Opti' });
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/can’t be made public/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('refuses to publish a lake gated by a required entitlement', async () => {
    const db = makeDb({ requiredEntitlement: 'product:pro' });
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/can’t be made public/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('blocks a non-owner admin from PUBLISHING (no exposing someone else’s lake app-wide)', async () => {
    const db = makeDb(); // lake owned by 'owner'
    await expect(
      setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/owner/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('is a no-op when already public (no update)', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });
});
