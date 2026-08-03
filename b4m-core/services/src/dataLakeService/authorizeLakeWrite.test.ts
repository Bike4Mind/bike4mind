import { describe, it, expect, vi } from 'vitest';
import { assertCanWriteDataLakeTags, canManageLake, extractDataLakeMetaTags } from './authorizeLakeWrite';

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

describe('extractDataLakeMetaTags', () => {
  it('lowercases, dedupes, and drops non-string entries', () => {
    expect(
      extractDataLakeMetaTags(['DataLake:OrgA:Acme-2026', 'datalake:orga:acme-2026', 'notes', null, undefined, 42])
    ).toEqual(['datalake:orga:acme-2026']);
  });
});
