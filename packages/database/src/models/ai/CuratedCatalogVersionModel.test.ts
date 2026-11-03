import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import {
  CuratedCatalogVersion,
  curatedCatalogVersionRepository,
  type NewCuratedCatalogVersion,
} from './CuratedCatalogVersionModel';

// Odd spacing, a non-ASCII character and a trailing newline: anything a re-serializer would change.
const manifestBytes =
  '{\n  "schemaVersion": 2,   "sequence": 1,\n  "notes": "caf' + String.fromCharCode(0xe9, 0x20, 0x2713) + '"\n}\n';
const signatureBytes = '{ "sequence": 1, "signatures": [] }\n';

const version = (overrides: Partial<NewCuratedCatalogVersion> = {}): NewCuratedCatalogVersion => ({
  channel: 'curated-v2',
  sequence: 1,
  position: overrides.position ?? overrides.sequence ?? 1,
  manifestBytes,
  signatureBytes,
  keyIds: ['0123456789abcdef'],
  origin: 'import',
  publishedBy: 'admin-1',
  reason: 'first list',
  ...overrides,
});

describe('CuratedCatalogVersionRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await CuratedCatalogVersion.collection.deleteMany({});
    await curatedCatalogVersionRepository.ready();
  });

  it('round-trips the exact texts and records their sha256', async () => {
    const stored = await curatedCatalogVersionRepository.append(version());
    const sha256 = createHash('sha256').update(Buffer.from(manifestBytes, 'utf8')).digest('hex');
    expect(stored?.sha256).toBe(sha256);
    const read = await curatedCatalogVersionRepository.findBySequence('curated-v2', 1);
    expect(read?.manifestBytes).toBe(manifestBytes);
    expect(Buffer.from(read!.manifestBytes, 'utf8').equals(Buffer.from(manifestBytes, 'utf8'))).toBe(true);
    expect(read).toMatchObject({ signatureBytes, sha256, keyIds: ['0123456789abcdef'], origin: 'import' });
    expect(read).not.toHaveProperty('_id');
  });

  it('serves the highest position as latest, per channel, even over a higher sequence', async () => {
    expect(await curatedCatalogVersionRepository.latest('curated-v2')).toBeNull();
    await curatedCatalogVersionRepository.append(version({ sequence: 2, position: 1 }));
    await curatedCatalogVersionRepository.append(version({ sequence: 1002, position: 2 }));
    await curatedCatalogVersionRepository.append(version({ sequence: 3, position: 3 }));
    await curatedCatalogVersionRepository.append(version({ channel: 'other', sequence: 99, position: 9 }));
    expect((await curatedCatalogVersionRepository.latest('curated-v2'))?.sequence).toBe(3);
    expect(await curatedCatalogVersionRepository.findBySequence('curated-v2', 4)).toBeNull();
  });

  it('finds the highest sequence any of the given keys signed, per channel', async () => {
    const repo = curatedCatalogVersionRepository;
    await repo.append(version({ sequence: 2, position: 1, keyIds: ['old'] }));
    await repo.append(version({ sequence: 500, position: 2, keyIds: ['old', 'recovery'] }));
    await repo.append(version({ sequence: 1002, position: 3, keyIds: ['leaked'] }));
    await repo.append(version({ channel: 'other', sequence: 900, position: 1, keyIds: ['old'] }));
    expect(await repo.highestSequenceSignedBy('curated-v2', ['old'])).toBe(500);
    expect(await repo.highestSequenceSignedBy('curated-v2', ['leaked', 'recovery'])).toBe(1002);
    expect(await repo.highestSequenceSignedBy('curated-v2', ['unknown'])).toBe(0);
    expect(await repo.highestSequenceSignedBy('curated-v2', [])).toBe(0);
  });

  it('reads only the served text', async () => {
    await curatedCatalogVersionRepository.append(version({ sequence: 2, position: 1 }));
    await curatedCatalogVersionRepository.append(version({ sequence: 5, position: 2, signatureBytes: 'sig-5' }));
    const repo = curatedCatalogVersionRepository;
    expect(await repo.readServed('curated-v2', 'latest', 'signatureBytes')).toBe('sig-5');
    expect(await repo.readServed('curated-v2', 2, 'manifestBytes')).toBe(manifestBytes);
    expect(await repo.readServed('curated-v2', 3, 'manifestBytes')).toBeNull();
    const findOne = vi.spyOn(CuratedCatalogVersion, 'findOne');
    await repo.readServed('curated-v2', 5, 'manifestBytes');
    expect(findOne.mock.calls[0][1]).toEqual({ _id: 0, manifestBytes: 1 });
    findOne.mockRestore();
  });

  it('refuses a second version with the same sequence or the same position', async () => {
    expect(await curatedCatalogVersionRepository.append(version())).not.toBeNull();
    expect(await curatedCatalogVersionRepository.append(version({ manifestBytes: '{}', position: 2 }))).toBeNull();
    expect(await curatedCatalogVersionRepository.append(version({ sequence: 2, position: 1 }))).toBeNull();
    expect((await curatedCatalogVersionRepository.findBySequence('curated-v2', 1))?.manifestBytes).toBe(manifestBytes);
    expect(await CuratedCatalogVersion.countDocuments()).toBe(1);
  });

  it('never updates or deletes a published version', async () => {
    await curatedCatalogVersionRepository.append(version());
    const filter = { channel: 'curated-v2', sequence: 1 };
    const Model = CuratedCatalogVersion;
    await expect(Model.updateOne(filter, { manifestBytes: '{}' })).rejects.toThrow(/immutable/);
    await expect(Model.updateMany({}, { manifestBytes: '{}' })).rejects.toThrow(/immutable/);
    await expect(Model.findOneAndUpdate(filter, { manifestBytes: '{}' })).rejects.toThrow(/immutable/);
    await expect(Model.replaceOne(filter, version())).rejects.toThrow(/immutable/);
    await expect(Model.findOneAndReplace(filter, version())).rejects.toThrow(/immutable/);
    await expect(Model.deleteOne(filter)).rejects.toThrow(/immutable/);
    await expect(Model.deleteMany({})).rejects.toThrow(/immutable/);
    await expect(Model.findOneAndDelete(filter)).rejects.toThrow(/immutable/);
    await expect(Model.bulkWrite([{ deleteOne: { filter } }])).rejects.toThrow(/immutable/);
    await expect(Model.aggregate([{ $match: {} }, { $out: Model.collection.name }])).rejects.toThrow(/immutable/);
    await expect(Model.aggregate([{ $merge: { into: Model.collection.name } }])).rejects.toThrow(/immutable/);
    expect(await Model.aggregate([{ $match: filter }, { $project: { _id: 0, sequence: 1 } }])).toEqual([
      { sequence: 1 },
    ]);
    const doc = await CuratedCatalogVersion.findOne(filter);
    doc!.manifestBytes = '{}';
    await expect(doc!.save()).rejects.toThrow(/immutable/);
    expect((await curatedCatalogVersionRepository.findBySequence('curated-v2', 1))?.manifestBytes).toBe(manifestBytes);
  });
});
