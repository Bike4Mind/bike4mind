import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  AssistantBriefModel,
  assistantBriefRepository,
  BRIEF_COMPOSING_STALE_MS,
  type AssistantBriefContent,
} from './AssistantBriefModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
afterEach(() => vi.restoreAllMocks());

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

const fromEmail = (emailId: string) => ({ kind: 'email' as const, emailId });

async function createEmailSourcedBrief(userId: string) {
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
    const mine = await createEmailSourcedBrief('user-me');
    const theirs = await createEmailSourcedBrief('user-other');

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

describe('assistantBriefRepository.findLatestReadyDecisionRefs', () => {
  const approval = { questId: 'q1', sessionId: 's1', pendingActionTs: 1 };
  const settle = async (userId: string, decisions: AssistantBriefContent['decisions']) => {
    const brief = await assistantBriefRepository.createComposing({ userId, periodStart: NOW, periodEnd: NOW });
    await assistantBriefRepository.markReady(String(brief._id), { ...content, decisions }, NOW);
    return String(brief._id);
  };

  it("returns the owner's newest ready brief, projected to its decisions' approval refs", async () => {
    await settle('owner', [{ id: 'old', text: 'Old decision' }]);
    const latest = await settle('owner', [
      { id: 'd1', text: 'Reply to the vendor' },
      { id: 'd2', text: 'Approve the deploy', approval },
    ]);
    await createBrief();
    await settle('someone-else', [{ id: 'x', text: 'Not yours' }]);

    const refs = await assistantBriefRepository.findLatestReadyDecisionRefs('owner');

    expect(String(refs?._id)).toBe(latest);
    expect(refs?.decisions).toEqual([{}, { approval }]);
  });

  const settleBlock = async (userId: string, decisions: AssistantBriefContent['decisions']) => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: NOW,
      periodEnd: NOW,
      trigger: 'busy_block',
      busyBlock: { start: NOW, end: NOW },
    });
    await assistantBriefRepository.markReady(String(brief._id), { ...content, decisions }, NOW);
    return String(brief._id);
  };

  it('keeps counting the regular brief after newer busy-block briefs, and counts theirs too', async () => {
    await settleBlock('owner', [{ id: 'old-block', text: 'Briefed before the regular one' }]);
    await settle('owner', [{ id: 'd1', text: 'Approve the deploy', approval }]);
    await settleBlock('owner', [{ id: 'b1', text: 'Reply to the email from the meeting' }]);
    const newest = await settleBlock('owner', []);

    const refs = await assistantBriefRepository.findLatestReadyDecisionRefs('owner');

    expect(String(refs?._id)).toBe(newest);
    expect(refs?.decisions).toHaveLength(2);
    expect(refs?.decisions).toEqual(expect.arrayContaining([{ approval }, {}]));
  });

  it('counts busy-block briefs when there is no regular ready brief', async () => {
    const only = await settleBlock('owner', [{ id: 'b1', text: 'Reply to the email' }]);

    const refs = await assistantBriefRepository.findLatestReadyDecisionRefs('owner');

    expect(String(refs?._id)).toBe(only);
    expect(refs?.decisions).toEqual([{}]);
  });

  it('is null when the owner has no ready brief', async () => {
    await createBrief();

    await expect(assistantBriefRepository.findLatestReadyDecisionRefs('owner')).resolves.toBeNull();
  });
});

describe('assistant brief reads', () => {
  it('finds the in-flight composing brief only while it is fresh', async () => {
    const brief = await createBrief();
    const created = (await assistantBriefRepository.findById(String(brief._id)))!.createdAt;

    expect(String((await assistantBriefRepository.findActiveComposing('owner', created))?._id)).toBe(String(brief._id));
    await expect(
      assistantBriefRepository.findActiveComposing('owner', new Date(created.getTime() + BRIEF_COMPOSING_STALE_MS))
    ).resolves.toBeNull();
    expect(await assistantBriefRepository.findActiveComposing('owner')).toMatchObject({ status: 'composing' });
  });

  it('lists and reads the latest ready brief of the owner only, and treats a malformed id as missing', async () => {
    const first = await createBrief();
    await assistantBriefRepository.markReady(String(first._id), content, NOW);
    await assistantBriefRepository.createComposing({ userId: 'someone-else', periodStart: NOW, periodEnd: NOW });

    expect((await assistantBriefRepository.listByUser('owner', 5)).map(b => String(b._id))).toEqual([
      String(first._id),
    ]);
    expect(String((await assistantBriefRepository.findLatestReady('owner'))?._id)).toBe(String(first._id));
    await expect(assistantBriefRepository.findById('not-an-id')).resolves.toBeNull();
    await expect(assistantBriefRepository.findByIdForUser('not-an-id', 'owner')).resolves.toBeNull();
    await expect(assistantBriefRepository.removeEmailSourcedItems('owner', [])).resolves.toBe(0);
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

describe('assistantBriefRepository lifecycle', () => {
  const window = { periodStart: new Date('2026-11-01T00:00:00.000Z'), periodEnd: new Date('2026-11-02T00:00:00.000Z') };
  const content = { headline: 'Done.', happened: [], handled: [], decisions: [] };

  it('creates a composing brief, settles it once and reads it back scoped to its owner', async () => {
    const brief = await assistantBriefRepository.createComposing({ userId: 'user-me', ...window });
    const id = brief._id.toString();

    expect(await assistantBriefRepository.findActiveComposing('user-me')).toMatchObject({ _id: brief._id });
    expect(
      await assistantBriefRepository.findActiveComposing('user-me', new Date(Date.now() + 10 * 60_000))
    ).toBeNull();

    expect(await assistantBriefRepository.markReady(id, content, window.periodEnd)).toBe(true);
    expect(await assistantBriefRepository.markFailed(id, 'late')).toBe(false);
    expect(await assistantBriefRepository.findLatestReady('user-me')).toMatchObject({
      status: 'ready',
      headline: 'Done.',
    });

    expect(await assistantBriefRepository.findByIdForUser(id, 'user-me')).toMatchObject({ status: 'ready' });
    expect(await assistantBriefRepository.findByIdForUser(id, 'user-other')).toBeNull();
    expect(await assistantBriefRepository.findByIdForUser('bad', 'user-me')).toBeNull();
    expect(await assistantBriefRepository.findById(id)).toMatchObject({ userId: 'user-me' });
    expect(await assistantBriefRepository.findById('bad')).toBeNull();
    expect(await assistantBriefRepository.listByUser('user-me', 5)).toHaveLength(1);
  });

  it('marks a composing brief failed', async () => {
    const brief = await assistantBriefRepository.createComposing({ userId: 'user-me', ...window });
    expect(await assistantBriefRepository.markFailed(brief._id.toString(), 'composition_failed')).toBe(true);
    expect(await assistantBriefRepository.markReady(brief._id.toString(), content, window.periodEnd)).toBe(false);
  });

  it('removes nothing for an empty email list', async () => {
    expect(await assistantBriefRepository.removeEmailSourcedItems('user-me', [])).toBe(0);
  });
});
