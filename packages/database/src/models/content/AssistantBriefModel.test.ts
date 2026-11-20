import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
afterEach(() => vi.restoreAllMocks());

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

describe('assistant brief settlement', () => {
  it('validates ready content while settling only a composing brief', async () => {
    const update = vi.spyOn(AssistantBriefModel, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    const content = { headline: 'Ready', happened: [], handled: [], decisions: [] };
    const composedAt = new Date('2026-01-01');

    expect(await assistantBriefRepository.markReady('brief', content, composedAt)).toBe(true);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: 'brief', status: 'composing' },
      { $set: { ...content, status: 'ready', composedAt } },
      { runValidators: true }
    );
  });

  it('validates failure details without claiming an already settled brief changed', async () => {
    const update = vi.spyOn(AssistantBriefModel, 'updateOne').mockResolvedValue({ modifiedCount: 0 } as never);

    expect(await assistantBriefRepository.markFailed('brief', 'Unavailable')).toBe(false);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: 'brief', status: 'composing' },
      { $set: { status: 'failed', failureReason: 'Unavailable' } },
      { runValidators: true }
    );
  });
});

describe('AssistantBriefModel source refs', () => {
  const brief = (source: Record<string, unknown>) => ({
    userId: 'user-me',
    status: 'ready',
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    periodEnd: new Date('2026-11-02T00:00:00.000Z'),
    handled: [{ id: 'x1', text: 'Summarized the report', source }],
  });

  it('stores a delegation source', async () => {
    const created = await AssistantBriefModel.create(brief({ kind: 'delegation', delegationId: 'g1' }));
    const stored = await AssistantBriefModel.findById(created._id).lean();
    expect(stored?.handled[0].source).toEqual({ kind: 'delegation', delegationId: 'g1' });
  });

  it('requires the id that matches the kind', async () => {
    await expect(AssistantBriefModel.create(brief({ kind: 'delegation', emailId: 'e1' }))).rejects.toThrow(
      /delegationId/
    );
    await expect(AssistantBriefModel.create(brief({ kind: 'email', delegationId: 'g1' }))).rejects.toThrow(/emailId/);
  });
});
