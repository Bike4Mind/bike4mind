import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { IMongoDocument } from '@bike4mind/common';
import { BaseRepository, softDeletePlugin, withTransaction } from '@bike4mind/db-core';
import { createMongoReplSet } from '../__test__/createMongoServer';

/**
 * Regression guard for org-groups #1228: `withTransaction(() => repo.delete(id))` must actually
 * roll back when the transaction aborts, for BOTH delete paths -
 *  - mechanism 2 (hard delete): BaseModel.delete no longer passes `{ session: undefined }`, which
 *    used to suppress transactionAsyncLocalStorage injection so the delete escaped and committed;
 *  - mechanism 1 (soft delete): softDeletePlugin's raw-driver `updateOne` now joins the ALS session
 *    via `withAlsSession`.
 *
 * Requires a REAL replica set - a standalone mongod cannot run transactions, so it cannot tell a
 * write that joins the session from one that escapes it (the whole bug).
 */

// Throwaway models: one hard-delete (no plugin), one soft-delete (plugin).
type TxnDoc = IMongoDocument & { name?: string };
const hardSchema = new mongoose.Schema<TxnDoc>({ name: String });
const softSchema = new mongoose.Schema<TxnDoc>({ name: String });
softSchema.plugin(softDeletePlugin);

class TxnRepo extends BaseRepository<TxnDoc> {}

let server: Awaited<ReturnType<typeof createMongoReplSet>>;
let HardModel: mongoose.Model<TxnDoc>;
let SoftModel: mongoose.Model<TxnDoc>;
let hardRepo: TxnRepo;
let softRepo: TxnRepo;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri());
  HardModel = mongoose.model<TxnDoc>('TxnHard', hardSchema);
  SoftModel = mongoose.model<TxnDoc>('TxnSoft', softSchema);
  hardRepo = new TxnRepo(HardModel);
  softRepo = new TxnRepo(SoftModel);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await HardModel.deleteMany({});
  await SoftModel.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const rawDoc = (model: mongoose.Model<TxnDoc>, id: mongoose.Types.ObjectId) =>
  mongoose.connection.collection(model.collection.name).findOne({ _id: id });

describe('BaseRepository.delete joins the caller transaction (org-groups #1228)', () => {
  it('mechanism 2 - a HARD delete rolls back when the transaction aborts', async () => {
    const doc = await HardModel.create({ name: 'keep-me' });

    await expect(
      withTransaction(async () => {
        await hardRepo.delete(doc.id);
        throw new Error('force abort'); // not transient -> withTransaction rethrows, no retry
      })
    ).rejects.toThrow('force abort');

    // Escaping the transaction would have committed the delete immediately; joining it rolls back.
    expect(await HardModel.findById(doc.id)).not.toBeNull();
  });

  it('mechanism 1 - a SOFT delete (plugin raw driver) rolls back when the transaction aborts', async () => {
    const doc = await SoftModel.create({ name: 'keep-me' });

    await expect(
      withTransaction(async () => {
        await softRepo.delete(doc.id);
        throw new Error('force abort');
      })
    ).rejects.toThrow('force abort');

    // deletedAt must be unset - the raw-driver soft-delete joined (and rolled back with) the txn.
    const raw = await rawDoc(SoftModel, doc._id as mongoose.Types.ObjectId);
    expect(raw?.deletedAt ?? null).toBeNull();
  });

  it('a committed transaction still deletes - hard row gone, soft row flagged', async () => {
    const hard = await HardModel.create({ name: 'gone' });
    const soft = await SoftModel.create({ name: 'flagged' });

    await withTransaction(async () => {
      await hardRepo.delete(hard.id);
      await softRepo.delete(soft.id);
    });

    expect(await HardModel.findById(hard.id)).toBeNull();
    const rawSoft = await rawDoc(SoftModel, soft._id as mongoose.Types.ObjectId);
    expect(rawSoft?.deletedAt).toBeInstanceOf(Date);
  });
});
