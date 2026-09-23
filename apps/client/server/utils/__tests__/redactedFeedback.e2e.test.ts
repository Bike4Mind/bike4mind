import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { FeedbackTextModel } from '@bike4mind/database';
import { feedbackContentExpiresAt } from '@bike4mind/common';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { hydrateFeedbackText } from '../redactedFeedback';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('hydrateFeedbackText', () => {
  it("preserves a pre-migration document's own content when no sibling row exists", async () => {
    // A document created before this PR's schema change: contentStored defaults to false (the
    // schema default, not an explicit unset), but the document itself still carries its content
    // directly - the exact shape a not-yet-migrated legacy row has.
    const legacyItem = {
      id: new mongoose.Types.ObjectId().toString(),
      contentStored: false,
      content: 'a pre-migration report',
    };

    const [hydrated] = await hydrateFeedbackText([legacyItem]);

    expect(hydrated.content).toBe('a pre-migration report');
    expect(hydrated.contentExpired).toBe(false);
  });

  it('prefers the sibling content once the document has been migrated', async () => {
    const id = new mongoose.Types.ObjectId();
    await FeedbackTextModel.create({
      _id: id,
      content: 'the migrated sibling content',
      expiresAt: feedbackContentExpiresAt(new Date()),
    });
    const migratedItem = { id: id.toString(), contentStored: true, content: undefined };

    const [hydrated] = await hydrateFeedbackText([migratedItem]);

    expect(hydrated.content).toBe('the migrated sibling content');
    expect(hydrated.contentExpired).toBe(false);
  });

  it('reports contentExpired when contentStored is true but the sibling has aged out', async () => {
    const expiredItem = { id: new mongoose.Types.ObjectId().toString(), contentStored: true, content: undefined };

    const [hydrated] = await hydrateFeedbackText([expiredItem]);

    expect(hydrated.content).toBeUndefined();
    expect(hydrated.contentExpired).toBe(true);
  });

  it('does not report contentExpired for a report that never had content', async () => {
    const neverHadItem = { id: new mongoose.Types.ObjectId().toString(), contentStored: false, content: undefined };

    const [hydrated] = await hydrateFeedbackText([neverHadItem]);

    expect(hydrated.content).toBeUndefined();
    expect(hydrated.contentExpired).toBe(false);
  });

  it('returns an empty array for an empty input without querying', async () => {
    expect(await hydrateFeedbackText([])).toEqual([]);
  });
});
