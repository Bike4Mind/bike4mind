import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { AssistantBriefModel, assistantBriefRepository, type AssistantBriefContent } from './AssistantBriefModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AssistantBriefModel.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await AssistantBriefModel.deleteMany({});
});

const NOW = new Date('2026-11-18T00:00:00.000Z');
const createComposingBrief = () =>
  assistantBriefRepository.createComposing({ userId: 'owner', periodStart: NOW, periodEnd: NOW });
const content: AssistantBriefContent = {
  headline: 'Daily brief',
  happened: [{ id: 'item', text: 'Completed work' }],
  handled: [],
  decisions: [],
};

describe('assistant brief terminal updates', () => {
  it('settles valid content once and keeps the original owner', async () => {
    const brief = await createComposingBrief();
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
    const brief = await createComposingBrief();
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
    const brief = await createComposingBrief();
    const id = String(brief._id);

    await expect(assistantBriefRepository.markFailed(id, 'provider unavailable')).resolves.toBe(true);
    await expect(assistantBriefRepository.markReady(id, content, NOW)).resolves.toBe(false);
    expect(await assistantBriefRepository.findById(id)).toMatchObject({
      status: 'failed',
      failureReason: 'provider unavailable',
    });
  });
});

const fromEmail = (emailId: string) => ({ kind: 'email' as const, emailId });

async function createBrief(userId: string) {
  return AssistantBriefModel.create({
    userId,
    status: 'ready',
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    periodEnd: new Date('2026-11-02T00:00:00.000Z'),
    happened: [
      { id: 'h1', text: 'FYI from the deleted email', source: fromEmail('gone') },
      { id: 'h2', text: 'A model-written event' },
    ],
    handled: [{ id: 'x1', text: 'Receipt from a kept email', source: fromEmail('kept') }],
    decisions: [
      {
        id: 'd1',
        text: 'Reply to the deleted email',
        source: fromEmail('gone'),
        draftReply: { to: 'sender@example.com', subject: 'Re: hi', body: 'Draft body' },
      },
      { id: 'd2', text: 'Approve a tool call', approval: { questId: 'q', sessionId: 's', pendingActionTs: 1 } },
    ],
  });
}

describe('assistantBriefRepository.removeEmailSourcedItems', () => {
  it('removes every item sourced from the deleted emails in the owner briefs and keeps the rest', async () => {
    const mine = await createBrief('user-me');
    const theirs = await createBrief('user-other');

    expect(await assistantBriefRepository.removeEmailSourcedItems('user-me', ['gone'])).toBe(1);

    const after = await AssistantBriefModel.findById(mine._id).lean();
    expect(after?.happened.map(i => i.id)).toEqual(['h2']);
    expect(after?.handled.map(i => i.id)).toEqual(['x1']);
    expect(after?.decisions.map(d => d.id)).toEqual(['d2']);
    expect(JSON.stringify(after)).not.toContain('Draft body');

    const untouched = await AssistantBriefModel.findById(theirs._id).lean();
    expect(untouched?.decisions).toHaveLength(2);
  });
});
