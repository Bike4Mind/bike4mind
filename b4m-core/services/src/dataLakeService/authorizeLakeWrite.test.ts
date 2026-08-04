import { describe, it, expect, vi } from 'vitest';
import {
  assertBatchBelongsToLake,
  assertCanWriteDataLakeTags,
  assertMetaTagsMatchLake,
  canManageLake,
  extractDataLakeMetaTags,
} from './authorizeLakeWrite';

const LAKE = {
  id: 'lake-1',
  createdByUserId: 'lake-creator',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const dbWith = (lake: unknown) =>
  ({
    db: { dataLakes: { findByDatalakeTag: vi.fn(async () => lake) } },
  }) as never;

/**
 * Owning the FILE is not a route into the lake's manage decision, and these pin that so a future
 * "but the user owns the file" shortcut cannot be added without turning one of them red.
 *
 * A probe cannot tell the two apart: an admin who also owns a file gets through either way. The
 * structural answer is that `ManageActor` is `Pick<AccessContext, 'userId' | 'isAdmin'>`, so no
 * file and no ownership signal reaches the predicate at all - it decides on role and lake
 * creator, and there is nothing else for it to decide on.
 */
describe('canManageLake - file ownership is not an input', () => {
  it('refuses a non-admin who is not the lake creator, whatever they own elsewhere', () => {
    // Named as the file's owner to make the claim explicit; the predicate takes no file, so this
    // is the whole of what it can see about them.
    const fileOwner = { userId: 'file-owner', isAdmin: false };

    expect(canManageLake(LAKE, fileOwner)).toBe(false);
  });

  it('grants the lake creator', () => {
    expect(canManageLake(LAKE, { userId: 'lake-creator', isAdmin: false })).toBe(true);
  });

  it('grants an admin by role, not by any ownership they happen to hold', () => {
    // The disambiguation: this actor owns nothing and is not the creator. Only isAdmin is left,
    // so an admin getting through is the role arm firing and cannot be anything else.
    expect(canManageLake(LAKE, { userId: 'some-admin', isAdmin: true })).toBe(true);
  });

  it('fails closed when neither the actor nor the lake carries an identity', () => {
    // Without the truthiness guards, undefined === undefined would grant a synthetic fallback
    // lake to an actor with no userId.
    expect(canManageLake({ createdByUserId: undefined as unknown as string }, { userId: '', isAdmin: false })).toBe(
      false
    );
  });
});

describe('assertCanWriteDataLakeTags - the same rule at the write gate', () => {
  it('rejects the file owner applying a meta-tag for a lake they did not create', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'file-owner', isAdmin: false }, [LAKE.datalakeTag], dbWith(LAKE))
    ).rejects.toThrow("Only the creator can change this data lake's files");
  });

  it('accepts the lake creator', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'lake-creator', isAdmin: false }, [LAKE.datalakeTag], dbWith(LAKE))
    ).resolves.toBeUndefined();
  });

  it('rejects a meta-tag that resolves to no lake', async () => {
    await expect(
      assertCanWriteDataLakeTags({ userId: 'lake-creator', isAdmin: false }, [LAKE.datalakeTag], dbWith(null))
    ).rejects.toThrow("Only the creator can change this data lake's files");
  });

  it('ignores ordinary tags, so an unrelated write never reaches a lake lookup', async () => {
    const adapters = dbWith(LAKE) as unknown as { db: { dataLakes: { findByDatalakeTag: ReturnType<typeof vi.fn> } } };

    await assertCanWriteDataLakeTags({ userId: 'file-owner', isAdmin: false }, ['notes', 'acme:q1'], adapters as never);

    expect(adapters.db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });
});

describe('assertBatchBelongsToLake - the batch decides which lake its files join', () => {
  const MISMATCH = 'This upload must name the data lake its batch belongs to';

  it('accepts a batch bound to the lake the request resolved', () => {
    expect(() => assertBatchBelongsToLake({ dataLakeId: LAKE.id }, LAKE)).not.toThrow();
  });

  it('refuses a batch bound to a different lake', () => {
    expect(() => assertBatchBelongsToLake({ dataLakeId: 'lake-2' }, LAKE)).toThrow(MISMATCH);
  });

  it('refuses a request that resolved no lake at all', () => {
    // Otherwise the files land in this lake's batch while joining no lake.
    expect(() => assertBatchBelongsToLake({ dataLakeId: LAKE.id }, undefined)).toThrow(MISMATCH);
  });

  it('refuses a batch carrying no lake binding', () => {
    expect(() => assertBatchBelongsToLake({ dataLakeId: undefined as unknown as string }, LAKE)).toThrow(MISMATCH);
  });
});

describe('assertMetaTagsMatchLake - the tag must name the lake being written to', () => {
  const MISMATCH = 'A data lake tag on these files names a different data lake';

  it('rejects a meta-tag for another lake, even one the caller may write to', () => {
    // The write gate passes this actor for both lakes (admin), so the disagreement itself is
    // the only thing left to catch it.
    expect(() => assertMetaTagsMatchLake(LAKE, ['datalake:orgb:other-lake'])).toThrow(MISMATCH);
  });

  it('accepts the lake own tag whatever case it arrives in', () => {
    expect(() => assertMetaTagsMatchLake(LAKE, ['DataLake:OrgA:Acme-2026', 'acme:legal'])).not.toThrow();
  });

  it("accepts its own tag when the LAKE's stored tag is the mixed-case side", () => {
    // Nothing lowercases `datalakeTag` on the way into Mongo, so a row can hold mixed case; only
    // folding the payload would refuse that lake its own tag.
    expect(() => assertMetaTagsMatchLake({ datalakeTag: 'DataLake:OrgA:Acme-2026' }, [LAKE.datalakeTag])).not.toThrow();
  });

  it('accepts a payload with no meta-tag at all', () => {
    expect(() => assertMetaTagsMatchLake(LAKE, [])).not.toThrow();
    expect(() => assertMetaTagsMatchLake(LAKE, ['acme:legal', null, 42])).not.toThrow();
  });

  it('refuses every meta-tag when the lake has no tag of its own', () => {
    expect(() => assertMetaTagsMatchLake({ datalakeTag: undefined as unknown as string }, [LAKE.datalakeTag])).toThrow(
      MISMATCH
    );
  });
});

describe('extractDataLakeMetaTags', () => {
  it('lowercases, dedupes, and drops non-string entries', () => {
    expect(
      extractDataLakeMetaTags(['DataLake:OrgA:Acme-2026', 'datalake:orga:acme-2026', 'notes', null, undefined, 42])
    ).toEqual(['datalake:orga:acme-2026']);
  });
});
