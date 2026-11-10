import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { FeedbackStatus, FeedbackType, NO_FEEDBACK_DETAILS_PLACEHOLDER } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { countTriageNoise } from './feedbackTriageNoise';
import migration from './migrations/20260921240060_close-feedback-triage-noise';

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
  it('closes waitlist rows and comment-less thumbs-ups only, and a re-run changes nothing', async () => {
    const ids = await seed({
      waitlist: { tags: ['comingSoon', 'marketing'], content: 'Coming soon signup', contentStored: true },
      emptyTypeWaitlist: { tags: ['comingSoon'], type: '' },
      placeholderUp: { type: FeedbackType.THUMBS_UP, contentStored: true },
      oldWaitlist: { tags: ['comingSoon'], createdAt: new Date(Date.now() - 200 * DAY_MS) },
      bareUp: { type: FeedbackType.THUMBS_UP },
      legacyBlankUp: { type: FeedbackType.THUMBS_UP, content: '  ' },
      commentedUp: { type: FeedbackType.THUMBS_UP, contentStored: true },
      legacyCommentedUp: { type: FeedbackType.THUMBS_UP, content: 'nice' },
      bareDown: { type: FeedbackType.THUMBS_DOWN },
      taggedBug: { type: FeedbackType.BUG, tags: ['comingSoon'], contentStored: true },
      bug: { type: FeedbackType.BUG, contentStored: true },
      textUp: { type: FeedbackType.THUMBS_UP, contentStored: true },
      inProgressUp: { type: FeedbackType.THUMBS_UP, status: FeedbackStatus.InProgress },
    });

    const expiresAt = new Date(Date.now() + DAY_MS);
    await FeedbackTextModel.collection.insertMany([
      { _id: ids.placeholderUp, content: NO_FEEDBACK_DETAILS_PLACEHOLDER, expiresAt },
      { _id: ids.textUp, content: 'loved it', expiresAt },
    ] as never[]);

    expect(await countTriageNoise(new Date(Date.now() - 30 * DAY_MS))).toEqual({
      waitlistSignups: 2,
      bareThumbsUps: 2,
      placeholderThumbsUps: 1,
    });
    expect(await countTriageNoise()).toEqual({ waitlistSignups: 3, bareThumbsUps: 2, placeholderThumbsUps: 1 });

    await migration.up({ startedAt: new Date() });

    for (const name of ['waitlist', 'emptyTypeWaitlist', 'oldWaitlist', 'bareUp', 'legacyBlankUp', 'placeholderUp']) {
      expect(await statusOf(ids[name]), name).toBe(FeedbackStatus.Closed);
    }
    for (const name of ['commentedUp', 'legacyCommentedUp', 'textUp', 'bareDown', 'taggedBug', 'bug']) {
      expect(await statusOf(ids[name]), name).toBe(FeedbackStatus.New);
    }
    expect(await statusOf(ids.inProgressUp)).toBe(FeedbackStatus.InProgress);

    expect(await countTriageNoise()).toEqual({ waitlistSignups: 0, bareThumbsUps: 0, placeholderThumbsUps: 0 });
    await migration.up({ startedAt: new Date() });
    expect(await FeedbackModel.collection.countDocuments({ status: FeedbackStatus.New })).toBe(6);
  });
});
