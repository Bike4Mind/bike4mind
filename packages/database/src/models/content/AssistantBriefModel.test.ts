import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { AssistantBriefModel, assistantBriefRepository, type AssistantBriefContent } from './AssistantBriefModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AssistantBriefModel.init();
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await AssistantBriefModel.deleteMany({});
});

const NOW = new Date('2026-11-18T00:00:00.000Z');
const createBrief = () =>
  assistantBriefRepository.createComposing({ userId: 'owner', periodStart: NOW, periodEnd: NOW });
const content: AssistantBriefContent = {
  headline: 'Daily brief',
  happened: [{ id: 'item', text: 'Completed work' }],
  handled: [],
  decisions: [],
};

describe('assistant brief terminal updates', () => {
  it('settles valid content once and keeps the original owner', async () => {
    const brief = await createBrief();
    const id = String(brief._id);

    await expect(assistantBriefRepository.markReady(id, content, NOW)).resolves.toBe(true);
    await expect(assistantBriefRepository.markFailed(id, 'late failure')).resolves.toBe(false);
    expect(await assistantBriefRepository.findByIdForUser(id, 'owner')).toMatchObject({
      status: 'ready',
      happened: content.happened,
      composedAt: NOW,
    });
    expect(await assistantBriefRepository.findByIdForUser(id, 'another-owner')).toBeNull();
  });

  it('rejects empty item text without partially settling the composing row', async () => {
    const brief = await createBrief();
    const id = String(brief._id);

    await expect(
      assistantBriefRepository.markReady(
        id,
        {
          ...content,
          happened: [{ id: 'item', text: '' }],
        },
        NOW
      )
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(await assistantBriefRepository.findById(id)).toMatchObject({
      status: 'composing',
      headline: null,
      happened: [],
    });
  });

  it('settles a failed brief once without allowing a later ready overwrite', async () => {
    const brief = await createBrief();
    const id = String(brief._id);

    await expect(assistantBriefRepository.markFailed(id, 'provider unavailable')).resolves.toBe(true);
    await expect(assistantBriefRepository.markReady(id, content, NOW)).resolves.toBe(false);
    expect(await assistantBriefRepository.findById(id)).toMatchObject({
      status: 'failed',
      failureReason: 'provider unavailable',
    });
  });
});
