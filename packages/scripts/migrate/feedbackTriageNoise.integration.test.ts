import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { FeedbackStatus, FeedbackType, NO_FEEDBACK_DETAILS_PLACEHOLDER } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { countTriageNoise } from './feedbackTriageNoise';
import migration from './migrations/20260921240070_close-feedback-triage-noise';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
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

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(rows: Record<string, Record<string, unknown>>) {
  const base = { userId: 'u', username: 'u', status: FeedbackStatus.New, subject: 'product', contentStored: false };
  const entries = Object.entries(rows);
  const result = await FeedbackModel.collection.insertMany(
    entries.map(([, row]) => ({ ...base, createdAt: new Date(), ...row }))
  );
  return Object.fromEntries(entries.map(([name], i) => [name, result.insertedIds[i]]));
}

async function statusOf(id: unknown) {
  return (await FeedbackModel.collection.findOne({ _id: id as mongoose.Types.ObjectId }))?.status;
}

describe('close-feedback-triage-noise', () => {
  it('closes only waitlist rows, preserves every historical thumbs-up, and is idempotent', async () => {
    const ids = await seed({
      waitlist: { tags: ['comingSoon', 'marketing'], content: 'Coming soon signup', contentStored: true },
      emptyTypeWaitlist: { type: '', tags: ['comingSoon'] },
      oldWaitlist: { tags: ['comingSoon'], createdAt: new Date(Date.now() - 200 * DAY_MS) },
      bareUp: { type: FeedbackType.THUMBS_UP },
      legacyBlankUp: { type: FeedbackType.THUMBS_UP, content: '  ' },
      commentedUp: { type: FeedbackType.THUMBS_UP, contentStored: true },
      legacyCommentedUp: { type: FeedbackType.THUMBS_UP, content: 'nice' },
      placeholderUp: { type: FeedbackType.THUMBS_UP, content: NO_FEEDBACK_DETAILS_PLACEHOLDER },
      failedTextUp: { type: FeedbackType.THUMBS_UP, contentStored: false },
      expiredTextUp: {
        type: FeedbackType.THUMBS_UP,
        contentStored: true,
        createdAt: new Date(Date.now() - 200 * DAY_MS),
      },
      taggedUp: { type: FeedbackType.THUMBS_UP, tags: ['comingSoon'] },
      bareDown: { type: FeedbackType.THUMBS_DOWN },
      taggedBug: { type: FeedbackType.BUG, tags: ['comingSoon'], contentStored: true },
      bug: { type: FeedbackType.BUG, contentStored: true },
      inProgressUp: { type: FeedbackType.THUMBS_UP, status: FeedbackStatus.InProgress },
    });

    await FeedbackTextModel.collection.insertMany([
      { _id: ids.placeholderUp, content: NO_FEEDBACK_DETAILS_PLACEHOLDER, expiresAt: new Date(Date.now() + DAY_MS) },
      { _id: ids.commentedUp, content: 'loved it', expiresAt: new Date(Date.now() + DAY_MS) },
    ]);

    expect(await countTriageNoise(new Date(Date.now() - 30 * DAY_MS))).toEqual({
      waitlistSignups: 2,
    });
    expect(await countTriageNoise()).toEqual({ waitlistSignups: 3 });

    await migration.up({ startedAt: new Date() });

    for (const name of ['waitlist', 'emptyTypeWaitlist', 'oldWaitlist']) {
      expect(await statusOf(ids[name]), name).toBe(FeedbackStatus.Closed);
    }
    for (const name of [
      'bareUp',
      'legacyBlankUp',
      'commentedUp',
      'legacyCommentedUp',
      'placeholderUp',
      'failedTextUp',
      'expiredTextUp',
      'taggedUp',
      'bareDown',
      'taggedBug',
      'bug',
    ]) {
      expect(await statusOf(ids[name]), name).toBe(FeedbackStatus.New);
    }
    expect(await statusOf(ids.inProgressUp)).toBe(FeedbackStatus.InProgress);

    expect(await countTriageNoise()).toEqual({ waitlistSignups: 0 });
    await migration.up({ startedAt: new Date() });
    expect(await FeedbackModel.collection.countDocuments({ status: FeedbackStatus.New })).toBe(11);
  });
});
