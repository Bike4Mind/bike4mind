import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mongoose } from '@bike4mind/database';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SubjectRecordExport, assertEveryModelClassified } from './subjectRecordExport';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('SubjectRecordExport over the real registry', () => {
  // `strictQuery: 'throw'` makes any registry path a schema does not declare fail here, and every
  // viaParent child must find its parent already read.
  it('queries every classified model without error', async () => {
    assertEveryModelClassified(mongoose.modelNames());
    const userId = new mongoose.Types.ObjectId().toString();
    const exporter = new SubjectRecordExport({ userId, email: 'subject@example.com' });

    const failures: string[] = [];
    for (const model of exporter.models) {
      try {
        for await (const _record of exporter.records(model)) void _record;
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(exporter.models.length).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });

  it("withholds the other people and the abuse scoring on the subject's own User record", async () => {
    const userId = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await mongoose.model('User').collection.insertOne({
      _id: userId,
      email: 'own-record@example.com',
      password: 'hash',
      referredByUserId: other,
      throttle: { changedBy: other },
      signupLanding: { notebookOwnerId: other },
      signupGrantAssessment: { band: 'review' },
    });
    const exporter = new SubjectRecordExport({ userId: userId.toString(), email: 'own-record@example.com' });

    const records = [];
    for await (const record of exporter.records('User')) records.push(JSON.parse(JSON.stringify(record)));

    expect(records).toEqual([
      { _id: userId.toString(), email: 'own-record@example.com', throttle: {}, signupLanding: {} },
    ]);
  });
});
