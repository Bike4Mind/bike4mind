import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { IMongoDocument } from '@bike4mind/common';
import { BaseRepository, softDeletePlugin } from '@bike4mind/db-core';
import { createMongoServer } from '../__test__/createMongoServer';

/**
 * softDeletePlugin's update hook: findOneAndUpdate/updateOne/updateMany skip tombstones by default,
 * like the read hooks, so a whole-doc `repo.update(snapshot)` cannot resurrect a soft-deleted doc.
 * Opt-outs: `includeDeleted`, a caller filter with a top-level `deletedAt`, and update-verb upserts.
 * Replace upserts are not exempt: they fail closed with E11000 rather than drop `deletedAt`.
 */

type SoftDoc = IMongoDocument & { name?: string; slug?: string; deletedAt?: Date | null };
const softSchema = new mongoose.Schema<SoftDoc>({ name: String, slug: { type: String, unique: true } });
softSchema.plugin(softDeletePlugin);

class SoftRepo extends BaseRepository<SoftDoc> {}

let server: Awaited<ReturnType<typeof createMongoServer>>;
let SoftModel: mongoose.Model<SoftDoc>;
let repo: SoftRepo;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  SoftModel = mongoose.model<SoftDoc>('SoftDeleteUpdateHooks', softSchema);
  await SoftModel.init();
  repo = new SoftRepo(SoftModel);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await SoftModel.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

// Straight from the collection: the plugin's find hooks hide tombstones.
const rawDoc = (id: mongoose.Types.ObjectId) => SoftModel.collection.findOne({ _id: id });

const includeDeleted = { includeDeleted: true } as mongoose.QueryOptions;

const seedTombstone = async (slug = 'dead') => {
  const doc = await SoftModel.create({ name: 'before', slug });
  await SoftModel.deleteOne({ _id: doc._id });
  const raw = await rawDoc(doc._id);
  expect(raw?.deletedAt).toBeInstanceOf(Date);
  return { id: doc._id, deletedAt: raw!.deletedAt as Date };
};

describe('softDeletePlugin update hook', () => {
  it('findOneAndUpdate / findByIdAndUpdate / updateOne on a tombstone are no-ops', async () => {
    const { id } = await seedTombstone();

    expect(await SoftModel.findOneAndUpdate({ _id: id }, { $set: { name: 'x' } }, { new: true })).toBeNull();
    expect(await SoftModel.findByIdAndUpdate(id, { $set: { name: 'x' } }, { new: true })).toBeNull();
    expect((await SoftModel.updateOne({ _id: id }, { $set: { name: 'x' } })).matchedCount).toBe(0);
    expect((await rawDoc(id))?.name).toBe('before');
  });

  it('updateMany skips tombstones but still updates live docs', async () => {
    const { id: deadId } = await seedTombstone();
    const live = await SoftModel.create({ name: 'before', slug: 'live' });

    const result = await SoftModel.updateMany({}, { $set: { name: 'after' } });

    expect(result.matchedCount).toBe(1);
    expect((await rawDoc(live._id))?.name).toBe('after');
    expect((await rawDoc(deadId))?.name).toBe('before');
  });

  it('a whole-doc repo.update snapshot does not resurrect a tombstone', async () => {
    const { id, deletedAt } = await seedTombstone();

    const result = await repo.update({ id: id.toString(), name: 'snap', deletedAt: null });

    expect(result).toBeNull();
    const raw = await rawDoc(id);
    expect(raw?.deletedAt).toEqual(deletedAt);
    expect(raw?.name).toBe('before');
  });

  it('repo.updateGuarded on a tombstone returns null rather than a concurrency conflict', async () => {
    const { id } = await seedTombstone();

    await expect(repo.updateGuarded({ id: id.toString(), name: 'snap', __v: 0 } as SoftDoc)).resolves.toBeNull();
  });

  it('includeDeleted opts out, as a query option, via setOptions, and through repo.update', async () => {
    const { id } = await seedTombstone();

    expect((await SoftModel.updateOne({ _id: id }, { $set: { name: 'a' } }, includeDeleted)).modifiedCount).toBe(1);
    expect((await rawDoc(id))?.name).toBe('a');

    await SoftModel.updateOne({ _id: id }, { $set: { name: 'b' } }).setOptions(includeDeleted);
    expect((await rawDoc(id))?.name).toBe('b');

    const updated = await repo.update({ id: id.toString(), name: 'c' }, { includeDeleted: true });
    expect(updated?.name).toBe('c');

    const raw = await rawDoc(id);
    expect(raw?.deletedAt).toBeInstanceOf(Date);
    expect(raw).not.toHaveProperty('includeDeleted');
  });

  it('a filter with an explicit top-level deletedAt writes', async () => {
    const { id, deletedAt } = await seedTombstone();

    await SoftModel.updateOne({ _id: id, deletedAt: { $ne: null } }, { $set: { name: 'ne' } });
    expect((await rawDoc(id))?.name).toBe('ne');

    await SoftModel.updateOne({ _id: id, deletedAt }, { $set: { name: 'stamped' } });
    expect((await rawDoc(id))?.name).toBe('stamped');

    await SoftModel.updateOne({ _id: id, deletedAt: { $exists: true } }, { $set: { name: 'exists' } });
    expect((await rawDoc(id))?.name).toBe('exists');
  });

  // Characterizes the documented limitation: only a top-level deletedAt counts as the caller taking
  // over, so one nested in $or/$and still gets the guard ANDed on and matches nothing.
  it('a deletedAt nested in $or / $and is not detected and stays guarded', async () => {
    const { id } = await seedTombstone();

    const or = await SoftModel.updateOne({ $or: [{ _id: id, deletedAt: { $ne: null } }] }, { $set: { name: 'or' } });
    const and = await SoftModel.updateOne(
      { $and: [{ _id: id }, { deletedAt: { $ne: null } }] },
      { $set: { name: 'and' } }
    );

    expect([or.matchedCount, and.matchedCount]).toEqual([0, 0]);
    expect((await rawDoc(id))?.name).toBe('before');
  });

  it('an upsert onto a tombstoned unique key keeps matching the tombstone (no E11000)', async () => {
    const { id } = await seedTombstone('taken');

    await expect(
      SoftModel.updateOne({ slug: 'taken' }, { $set: { name: 'upserted' } }, { upsert: true })
    ).resolves.toMatchObject({ matchedCount: 1 });

    expect(await SoftModel.collection.countDocuments()).toBe(1);
    expect((await rawDoc(id))?.name).toBe('upserted');
  });

  it('an upsert onto a tombstone leaves it deleted', async () => {
    const { id, deletedAt } = await seedTombstone('taken');

    await SoftModel.updateOne({ slug: 'taken' }, { $set: { name: 'upserted' } }, { upsert: true });

    expect((await rawDoc(id))?.deletedAt).toEqual(deletedAt);
  });

  it('a filter with deletedAt: undefined is still guarded', async () => {
    const { id } = await seedTombstone();

    // ignoreUndefined makes the driver drop the key, so a hook that treated it as the caller's own
    // deletedAt constraint would leave the filter as bare { _id } and write the tombstone.
    const result = await SoftModel.updateOne({ _id: id, deletedAt: undefined }, { $set: { name: 'x' } }, {
      ignoreUndefined: true,
    } as mongoose.QueryOptions);

    expect(result.matchedCount).toBe(0);
    expect((await rawDoc(id))?.name).toBe('before');
  });

  it('replaceOne / findOneAndReplace on a tombstone are no-ops unless includeDeleted', async () => {
    const { id, deletedAt } = await seedTombstone();

    expect((await SoftModel.replaceOne({ _id: id }, { name: 'r', slug: 'dead' })).matchedCount).toBe(0);
    expect(await SoftModel.findOneAndReplace({ _id: id }, { name: 'r', slug: 'dead' })).toBeNull();
    expect(await rawDoc(id)).toMatchObject({ name: 'before', deletedAt });

    await SoftModel.replaceOne({ _id: id }, { name: 'r1', slug: 'dead', deletedAt }, includeDeleted);
    expect((await rawDoc(id))?.name).toBe('r1');
    await SoftModel.findOneAndReplace({ _id: id }, { name: 'r2', slug: 'dead', deletedAt }, includeDeleted);
    expect(await rawDoc(id)).toMatchObject({ name: 'r2', deletedAt });
  });

  // A replacement drops every field it omits, so matching the tombstone would clear deletedAt.
  it('a replace upsert onto a tombstoned unique key fails with E11000 and leaves it deleted', async () => {
    const { id, deletedAt } = await seedTombstone('taken');

    await expect(
      SoftModel.replaceOne({ slug: 'taken' }, { name: 'up', slug: 'taken' }, { upsert: true })
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      SoftModel.findOneAndReplace({ slug: 'taken' }, { name: 'up', slug: 'taken' }, { upsert: true })
    ).rejects.toMatchObject({ code: 11000 });

    expect(await SoftModel.collection.countDocuments()).toBe(1);
    expect(await rawDoc(id)).toMatchObject({ name: 'before', deletedAt });
  });

  it('doc.updateOne() on a doc loaded with includeDeleted needs its own includeDeleted', async () => {
    const { id, deletedAt } = await seedTombstone();
    const tomb = await SoftModel.findById(id).setOptions(includeDeleted);

    expect((await tomb!.updateOne({ $set: { name: 'lost' } })).matchedCount).toBe(0);
    await tomb!.updateOne({ $set: { name: 'doc' } }).setOptions(includeDeleted);

    expect(await rawDoc(id)).toMatchObject({ name: 'doc', deletedAt });
  });

  // Known gap: Model.bulkWrite fires no query middleware, so it bypasses the tombstone guard.
  it('bulkWrite is not hooked and still writes to a tombstone', async () => {
    const { id } = await seedTombstone();

    await SoftModel.bulkWrite([{ updateOne: { filter: { _id: id }, update: { $set: { name: 'bulk' } } } }]);

    expect((await rawDoc(id))?.name).toBe('bulk');
  });

  it('delete statics, findOneAndDelete, softDelete() and restore() still work', async () => {
    const a = await SoftModel.create({ slug: 'a' });
    const b = await SoftModel.create({ slug: 'b' });
    const c = await SoftModel.create({ slug: 'c' });
    const d = await SoftModel.create({ slug: 'd' });

    await SoftModel.deleteOne({ _id: a._id });
    await SoftModel.deleteMany({ _id: b._id });
    await SoftModel.findOneAndDelete({ _id: c._id });
    await (d as unknown as { softDelete: () => Promise<unknown> }).softDelete();
    for (const doc of [a, b, c, d]) {
      expect((await rawDoc(doc._id))?.deletedAt).toBeInstanceOf(Date);
    }

    const tomb = await SoftModel.findById(a._id).setOptions(includeDeleted);
    await (tomb as unknown as { restore: () => Promise<unknown> }).restore();
    expect((await rawDoc(a._id))?.deletedAt).toBeNull();
  });
});
