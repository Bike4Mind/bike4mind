import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types } from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235987_move-quest-answeredby-to-redirectedfrom';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

function quests() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  return db.collection('quests');
}

const find = (id: Types.ObjectId) => quests().findOne({ _id: id });
const newId = () => new Types.ObjectId();

describe('move-quest-answeredby-to-redirectedfrom migration (real DB)', () => {
  it('moves the requested id to redirectedFrom and the answerer into model.name', async () => {
    const q1 = newId();
    await quests().insertOne({
      _id: q1,
      promptMeta: { model: { name: 'retired-model', answeredBy: 'successor-model', backend: 'openai' } },
    });

    await migration.up();

    const doc = await find(q1);
    expect(doc?.promptMeta).toEqual({
      redirectedFrom: 'retired-model',
      model: { name: 'successor-model', backend: 'openai' },
    });
  });

  it('keeps an existing redirectedFrom', async () => {
    const q2 = newId();
    await quests().insertOne({
      _id: q2,
      promptMeta: { redirectedFrom: 'original', model: { name: 'middle', answeredBy: 'final' } },
    });

    await migration.up();

    const doc = await find(q2);
    expect(doc?.promptMeta).toEqual({ redirectedFrom: 'original', model: { name: 'final' } });
  });

  it('leaves quests without answeredBy untouched', async () => {
    const plain = { _id: newId(), promptMeta: { model: { name: 'gpt-x' } } };
    const noMeta = { _id: newId() };
    const blank = { _id: newId(), promptMeta: { model: { name: 'gpt-y', answeredBy: '' } } };
    await quests().insertMany([plain, noMeta, blank]);

    await migration.up();

    expect(await find(plain._id)).toEqual(plain);
    expect(await find(noMeta._id)).toEqual(noMeta);
    expect(await find(blank._id)).toEqual(blank);
  });

  it('skips quests created before the answeredBy format existed', async () => {
    const old = {
      _id: Types.ObjectId.createFromTime(Date.UTC(2026, 8, 1) / 1000),
      promptMeta: { model: { name: 'retired-model', answeredBy: 'successor-model' } },
    };
    await quests().insertOne(old);

    await migration.up();

    expect(await find(old._id)).toEqual(old);
  });

  it('is a no-op on re-run', async () => {
    const q6 = newId();
    await quests().insertOne({
      _id: q6,
      promptMeta: { model: { name: 'retired-model', answeredBy: 'successor-model' } },
    });

    await migration.up();
    await migration.up();

    expect((await find(q6))?.promptMeta).toEqual({
      redirectedFrom: 'retired-model',
      model: { name: 'successor-model' },
    });
  });
});
