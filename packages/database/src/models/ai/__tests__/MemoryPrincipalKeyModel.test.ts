import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import MemoryPrincipalKeyModel, { memoryPrincipalKeyRepository } from '../MemoryPrincipalKeyModel';

/**
 * `getOrCreate` takes a `startedAt` for the crypto-shred fence. Defaulted to call time here, which is
 * what the pre-fence tests want: a tombstone raised earlier lifts, so the ordinary mint/read path runs.
 * The fence tests below pass explicit timestamps.
 */
const getOrCreate = (
  kind: Parameters<typeof memoryPrincipalKeyRepository.getOrCreate>[0],
  id: string,
  owner: string,
  candidate: string,
  startedAt: Date = new Date()
) => memoryPrincipalKeyRepository.getOrCreate(kind, id, owner, candidate, startedAt);

describe('MemoryPrincipalKeyRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await MemoryPrincipalKeyModel.ensureIndexes();
  });

  it('mints a key on first getOrCreate, then returns the same key (idempotent)', async () => {
    const first = await getOrCreate('user', 'u1', 'u1', 'dek-A');
    const second = await getOrCreate('user', 'u1', 'u1', 'dek-B');
    expect(first).toBe('dek-A');
    expect(second).toBe('dek-A'); // the second candidate is ignored; one key per principal
  });

  it('findDek returns the key, and null once destroyed (crypto-shred)', async () => {
    await getOrCreate('user', 'u1', 'u1', 'dek-A');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBe('dek-A');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBeNull();
  });

  // The fence. A hard delete left no evidence a shred had ever happened, so the append path's upsert
  // silently re-minted and the facts it wrote decrypted normally, were never marked shredded, and were
  // served by recall.
  describe('crypto-shred fence', () => {
    it('leaves a tombstone instead of deleting the row, and stops reading as a key', async () => {
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');

      expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBeNull();
      // The row survives - that is what carries the "when" the fence compares against. The key itself
      // is genuinely gone, so the shred guarantee is unchanged.
      const row = await MemoryPrincipalKeyModel.findOne({ principalKind: 'user', principalId: 'u1' }).lean();
      expect(row).not.toBeNull();
      expect(row?.dek).toBeUndefined();
      expect(row?.destroyedAt).toBeInstanceOf(Date);
    });

    it('refuses to re-key for work that began before the shred', async () => {
      const startedAt = new Date(Date.now() - 60_000);
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');

      expect(await getOrCreate('user', 'u1', 'u1', 'dek-B', startedAt)).toBeNull();
      // And it stays refused - the failed attempt must not have minted anything.
      expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBeNull();
    });

    it('re-keys for work that began after the shred, so a rebuild is still possible', async () => {
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');

      const fresh = await getOrCreate('user', 'u1', 'u1', 'dek-B', new Date(Date.now() + 60_000));
      expect(fresh).toBe('dek-B');
      // The stamp is RETAINED beside the new key. Clearing it erased the only evidence a shred had
      // happened, so the fence went blind to that shred the moment the principal legitimately wrote
      // again - see the fast-path test below, which is the interleaving that exploited it. A row
      // carrying both a live dek and a set destroyedAt is the normal steady state after any
      // erase-then-rebuild, not a malformed row.
      const row = await MemoryPrincipalKeyModel.findOne({ principalKind: 'user', principalId: 'u1' }).lean();
      expect(row?.destroyedAt).toBeInstanceOf(Date);
      expect(row?.dek).toBe('dek-B');
    });

    it('refuses a key RE-MINTED after this work began, not just a standing tombstone', async () => {
      // The fast path was an unfenced read: a caller whose work predates the shred found a live key
      // (re-minted by a legitimate later rebuild) and was handed it, so the erased principal's facts
      // were written back under a readable key. No exotic concurrency is needed - an ordinary
      // erase-then-rebuild, or a redelivered background job, produces exactly this interleaving.
      const oldWork = new Date(Date.now() - 60_000);
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');
      // A later, legitimate rebuild lifts the tombstone and mints a fresh key.
      expect(await getOrCreate('user', 'u1', 'u1', 'dek-B', new Date(Date.now() + 60_000))).toBe('dek-B');

      // The stale caller must still be refused, even though there is now a perfectly live key to read.
      expect(await getOrCreate('user', 'u1', 'u1', 'dek-C', oldWork)).toBeNull();
      // ...and refusing must not disturb the key the legitimate rebuild is using.
      expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBe('dek-B');
    });

    it('leaves a tombstone for a principal that had no row yet, so a first mint in flight is refused', async () => {
      // `destroy` was a plain update, a silent no-op on a missing row - so an erase issued before the
      // principal's first-ever key left nothing for the in-flight first mint to be refused by, and it
      // inserted its key and wrote under it after the erase.
      const oldWork = new Date(Date.now() - 60_000);
      await memoryPrincipalKeyRepository.destroy('user', 'never-keyed');

      const row = await MemoryPrincipalKeyModel.findOne({ principalKind: 'user', principalId: 'never-keyed' }).lean();
      expect(row?.destroyedAt).toBeInstanceOf(Date);
      expect(row?.dek).toBeUndefined();

      expect(await getOrCreate('user', 'never-keyed', 'never-keyed', 'dek-X', oldWork)).toBeNull();
      // A fresh unit of work may still legitimately key the principal, and its mint sets the
      // ownerUserId the tombstone row never carried.
      expect(await getOrCreate('user', 'never-keyed', 'never-keyed', 'dek-Y', new Date(Date.now() + 60_000))).toBe(
        'dek-Y'
      );
      const rekeyed = await MemoryPrincipalKeyModel.findOne({
        principalKind: 'user',
        principalId: 'never-keyed',
      }).lean();
      expect(rekeyed?.ownerUserId).toBe('never-keyed');
    });

    it('findKeyState reports the key and the retained stamp; findDek stays fence-free for decrypt', async () => {
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      expect(await memoryPrincipalKeyRepository.findKeyState('user', 'u1')).toEqual({
        dek: 'dek-A',
        destroyedAt: null,
      });
      expect(await memoryPrincipalKeyRepository.findKeyState('user', 'absent')).toBeNull();

      await memoryPrincipalKeyRepository.destroy('user', 'u1');
      const tombstoned = await memoryPrincipalKeyRepository.findKeyState('user', 'u1');
      expect(tombstoned?.dek).toBeNull();
      expect(tombstoned?.destroyedAt).toBeInstanceOf(Date);

      // The DECRYPT path deliberately does not consult the fence: reading a key that exists
      // resurrects nothing, so only the write path pays for the wider projection.
      expect(await getOrCreate('user', 'u1', 'u1', 'dek-B', new Date(Date.now() + 60_000))).toBe('dek-B');
      expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBe('dek-B');
    });

    it('refuses a shred stamped in the SAME millisecond as the work started', async () => {
      // Millisecond collisions happen, and the two ways to be wrong are not symmetric: letting one
      // through can resurface erased data, refusing it costs one run that writes nothing.
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');
      const row = await MemoryPrincipalKeyModel.findOne({ principalKind: 'user', principalId: 'u1' }).lean();

      expect(await getOrCreate('user', 'u1', 'u1', 'dek-B', row!.destroyedAt!)).toBeNull();
    });

    it('mints for a principal that has never had a key, tombstone or not', async () => {
      // The regression that would hide every test above: a fence that refused first-ever writes would
      // silently switch memory off for everyone.
      expect(await getOrCreate('user', 'brand-new', 'brand-new', 'dek-N', new Date(0))).toBe('dek-N');
    });

    it('lets exactly one of two concurrent lifts win, so a principal never holds two keys', async () => {
      // The unique index is what guarantees this; the point of the test is that losing the race
      // resolves to a READ of the winner rather than an E11000 escaping as a 500.
      await getOrCreate('user', 'u1', 'u1', 'dek-A');
      await memoryPrincipalKeyRepository.destroy('user', 'u1');

      const later = new Date(Date.now() + 60_000);
      const results = await Promise.all(
        ['dek-B', 'dek-C', 'dek-D'].map(dek => getOrCreate('user', 'u1', 'u1', dek, later))
      );

      expect(new Set(results).size).toBe(1);
      expect(await MemoryPrincipalKeyModel.countDocuments({ principalKind: 'user', principalId: 'u1' })).toBe(1);
    });
  });

  it('refuses an unscoped destroy rather than shredding an arbitrary tenant key', async () => {
    // Mongoose STRIPS undefined keys out of a query filter, so `destroy('lake', undefined)` degrades
    // to `deleteOne({ principalKind: 'lake' })` - a crypto-shred of whichever lake mongo returns
    // first, with no way back. Callers all check today; the guard puts the invariant on the only
    // method that cannot be undone.
    await getOrCreate('lake', 'lake:one', 'owner1', 'dek-1');
    await getOrCreate('lake', 'lake:two', 'owner2', 'dek-2');

    await expect(memoryPrincipalKeyRepository.destroy('lake', undefined as unknown as string)).rejects.toThrow(
      /principalId/
    );
    await expect(memoryPrincipalKeyRepository.destroy('lake', '')).rejects.toThrow(/principalId/);

    // Both survive - the point of the guard.
    expect(await memoryPrincipalKeyRepository.findDek('lake', 'lake:one')).toBe('dek-1');
    expect(await memoryPrincipalKeyRepository.findDek('lake', 'lake:two')).toBe('dek-2');
  });

  it('mints exactly one key under a concurrent first-write race (E11000 -> read the winner)', async () => {
    // Mongo does not serialize upserts: several first-writes for the same new principal all attempt the
    // insert, the unique index rejects the losers with E11000, and getOrCreate must turn that into a read
    // of the winner's key rather than throwing (which would drop the mirrored fact).
    const candidates = ['dek-A', 'dek-B', 'dek-C', 'dek-D', 'dek-E'];
    const results = await Promise.all(candidates.map(dek => getOrCreate('user', 'race', 'race', dek)));

    // Every caller gets the SAME key, and only one document was ever created.
    const winner = results[0];
    expect(candidates).toContain(winner);
    expect(results.every(r => r === winner)).toBe(true);
    expect(await MemoryPrincipalKeyModel.countDocuments({ principalKind: 'user', principalId: 'race' })).toBe(1);
  });

  it('isolates keys by principal', async () => {
    await getOrCreate('user', 'u1', 'u1', 'dek-1');
    await getOrCreate('user', 'u2', 'u2', 'dek-2');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2'); // u2 untouched
  });

  it('mints and reads back a key for a lake-kind principal (schema enum admits the new principal)', async () => {
    const dek = await getOrCreate('lake', 'lake:corpus', 'owner1', 'dek-lake');
    expect(dek).toBe('dek-lake');
    expect(await memoryPrincipalKeyRepository.findDek('lake', 'lake:corpus')).toBe('dek-lake');
  });

  it('persists a lake-kind key through the validating create path (enum admits lake)', async () => {
    // getOrCreate's upsert is the functional path; create() is the one that runs the schema enum
    // unconditionally, so this pins that the enum itself - not just the upsert - accepts 'lake'.
    const doc = await MemoryPrincipalKeyModel.create({
      principalKind: 'lake',
      principalId: 'lake:corpus',
      ownerUserId: 'owner1',
      dek: 'dek-lake',
    });
    expect(doc.principalKind).toBe('lake');
  });

  it('rejects an unknown principalKind on create (enum enforcement intact)', async () => {
    await expect(
      MemoryPrincipalKeyModel.create({
        // @ts-expect-error - deliberately invalid value to prove the enum still enforces
        principalKind: 'bogus',
        principalId: 'x',
        ownerUserId: 'x',
        dek: 'd',
      })
    ).rejects.toThrow(/enum|validation/i);
  });

  it('rejects an unknown principalKind through getOrCreate (runValidators gates the production path)', async () => {
    // The real write path is the upsert, not create(); without runValidators it would silently mint a
    // key the ledger enum rejects. This locks in that the upsert validates.
    await expect(
      // @ts-expect-error - deliberately invalid value
      getOrCreate('bogus', 'x', 'x', 'd')
    ).rejects.toThrow(/enum|validation/i);
  });
});
