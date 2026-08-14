import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import MemoryPrincipalKeyModel, { memoryPrincipalKeyRepository } from '../MemoryPrincipalKeyModel';

describe('MemoryPrincipalKeyRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await MemoryPrincipalKeyModel.ensureIndexes();
  });

  it('mints a key on first getOrCreate, then returns the same key (idempotent)', async () => {
    const first = await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-A');
    const second = await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-B');
    expect(first).toBe('dek-A');
    expect(second).toBe('dek-A'); // the second candidate is ignored; one key per principal
  });

  it('findDek returns the key, and null once destroyed (crypto-shred)', async () => {
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-A');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBe('dek-A');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBeNull();
  });

  it('mints exactly one key under a concurrent first-write race (E11000 -> read the winner)', async () => {
    // Mongo does not serialize upserts: several first-writes for the same new principal all attempt the
    // insert, the unique index rejects the losers with E11000, and getOrCreate must turn that into a read
    // of the winner's key rather than throwing (which would drop the mirrored fact).
    const candidates = ['dek-A', 'dek-B', 'dek-C', 'dek-D', 'dek-E'];
    const results = await Promise.all(
      candidates.map(dek => memoryPrincipalKeyRepository.getOrCreate('user', 'race', 'race', dek))
    );

    // Every caller gets the SAME key, and only one document was ever created.
    const winner = results[0];
    expect(candidates).toContain(winner);
    expect(results.every(r => r === winner)).toBe(true);
    expect(await MemoryPrincipalKeyModel.countDocuments({ principalKind: 'user', principalId: 'race' })).toBe(1);
  });

  it('isolates keys by principal', async () => {
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-1');
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u2', 'u2', 'dek-2');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2'); // u2 untouched
  });

  it('mints and reads back a key for a lake-kind principal (schema enum admits the new principal)', async () => {
    const dek = await memoryPrincipalKeyRepository.getOrCreate('lake', 'lake:corpus', 'owner1', 'dek-lake');
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
      memoryPrincipalKeyRepository.getOrCreate('bogus', 'x', 'x', 'd')
    ).rejects.toThrow(/enum|validation/i);
  });
});
