import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import {
  AssistantBriefModel,
  assistantBriefRepository,
  BRIEF_COMPOSING_STALE_MS,
  FOLLOW_UP_COMPOSING_TTL_MS,
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
      { $set: { ...content, status: 'ready', composedAt }, $unset: { followUpInput: 1 } },
      { runValidators: true }
    );
  });

  it('validates failure details without claiming an already settled brief changed', async () => {
    const update = vi.spyOn(AssistantBriefModel, 'updateOne').mockResolvedValue({ modifiedCount: 0 } as never);

    expect(await assistantBriefRepository.markFailed('brief', 'Unavailable')).toBe(false);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: 'brief', status: 'composing' },
      { $set: { status: 'failed', failureReason: 'Unavailable' }, $unset: { followUpInput: 1 } },
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

  it('stores an obligation source', async () => {
    const created = await AssistantBriefModel.create(brief({ kind: 'obligation', obligationId: 'o1' }));
    const stored = await AssistantBriefModel.findById(created._id).lean();
    expect(stored?.handled[0].source).toEqual({ kind: 'obligation', obligationId: 'o1' });
  });

  it('requires the id that matches the kind', async () => {
    await expect(AssistantBriefModel.create(brief({ kind: 'delegation', emailId: 'e1' }))).rejects.toThrow(
      /delegationId/
    );
    await expect(AssistantBriefModel.create(brief({ kind: 'obligation', delegationId: 'g1' }))).rejects.toThrow(
      /obligationId/
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

describe('assistant brief follow-ups', () => {
  const REMIND_AT = new Date('2026-11-18T09:00:00.000Z');
  const followUpContent: AssistantBriefContent = {
    headline: 'Follow-ups',
    happened: [],
    handled: [],
    decisions: [
      { id: 'fu-action-1', text: 'Book the room', followUp: { kind: 'actionItem', state: 'pending', remindAt: null } },
      {
        id: 'fu-email',
        text: 'Send follow-up to Sam: Notes',
        draftReply: { to: 'Sam', subject: 'Notes', body: 'Attached.' },
        followUp: { kind: 'followUpEmail', state: 'pending', remindAt: null },
      },
      {
        id: 'fu-reminder-1',
        text: 'Remind me: call back',
        followUp: { kind: 'reminder', state: 'pending', remindAt: REMIND_AT },
      },
    ],
  };
  const createFollowUpBrief = async (userId = 'owner') => {
    const brief = await assistantBriefRepository.createComposing({
      userId,
      periodStart: NOW,
      periodEnd: NOW,
      origin: 'followUp',
      followUpInput: { transcript: 'Book the room, email Sam, remind me', timeZone: 'UTC' },
    });
    await assistantBriefRepository.markReady(String(brief._id), followUpContent, NOW);
    return String(brief._id);
  };

  it('keeps the activity brief as the pending-decisions source when a newer follow-up brief is ready', async () => {
    const activity = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: NOW,
      periodEnd: NOW,
    });
    await assistantBriefRepository.markReady(
      String(activity._id),
      { ...content, decisions: [{ id: 'd1', text: 'Reply to the vendor' }] },
      NOW
    );
    await createFollowUpBrief();

    expect(String((await assistantBriefRepository.findLatestReadyDecisionRefs('owner'))?._id)).toBe(
      String(activity._id)
    );
  });

  it('clears the memo on settle and never dedupes with or shifts the activity window', async () => {
    const composing = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: NOW,
      periodEnd: NOW,
      origin: 'followUp',
      followUpInput: { transcript: 'memo' },
    });
    expect(await assistantBriefRepository.findActiveComposing('owner', NOW)).toBeNull();
    await assistantBriefRepository.markFailed(String(composing._id), 'composition_failed');
    expect((await assistantBriefRepository.findById(String(composing._id)))?.followUpInput).toBeUndefined();

    const id = await createFollowUpBrief();
    expect((await assistantBriefRepository.findById(id))?.followUpInput).toBeUndefined();
    expect(await assistantBriefRepository.findLatestReady('owner')).toBeNull();
  });

  it('resolves a pending follow-up once and refuses an edit after it', async () => {
    const id = await createFollowUpBrief();
    const resolve = () => assistantBriefRepository.resolveFollowUpDecision(id, 'owner', 'fu-email', 'approved', NOW);

    expect(await assistantBriefRepository.resolveFollowUpDecision(id, 'intruder', 'fu-email', 'approved')).toBe(false);
    await expect(resolve()).resolves.toBe(true);
    await expect(
      assistantBriefRepository.resolveFollowUpDecision(
        id,
        'owner',
        'fu-email',
        'dismissed',
        new Date('2026-11-19T09:00:00.000Z')
      )
    ).resolves.toBe(false);
    await expect(
      assistantBriefRepository.editFollowUpDecision(id, 'owner', 'fu-email', { draftReply: { to: 'sam@example.com' } })
    ).resolves.toBe(false);
    const stored = await assistantBriefRepository.findById(id);
    expect(stored?.decisions[1]).toMatchObject({
      draftReply: { to: 'Sam' },
      followUp: { state: 'approved', decidedAt: NOW },
    });
  });

  it('edits only the given fields of a pending follow-up', async () => {
    const id = await createFollowUpBrief();
    const later = new Date('2026-11-19T09:00:00.000Z');

    await expect(
      assistantBriefRepository.editFollowUpDecision(id, 'owner', 'fu-email', { draftReply: { to: 'sam@example.com' } })
    ).resolves.toBe(true);
    await expect(
      assistantBriefRepository.editFollowUpDecision(id, 'owner', 'fu-reminder-1', {
        text: 'Remind me: call Sam',
        remindAt: later,
      })
    ).resolves.toBe(true);
    await expect(assistantBriefRepository.editFollowUpDecision(id, 'owner', 'missing', { text: 'x' })).resolves.toBe(
      false
    );
    const stored = await assistantBriefRepository.findById(id);
    expect(stored?.decisions[1].draftReply).toEqual({ to: 'sam@example.com', subject: 'Notes', body: 'Attached.' });
    expect(stored?.decisions[2]).toMatchObject({ text: 'Remind me: call Sam', followUp: { remindAt: later } });
  });

  it('finds approved due reminders once, until they are marked surfaced', async () => {
    const id = await createFollowUpBrief();
    await createFollowUpBrief('another-owner');
    const after = new Date(REMIND_AT.getTime() + 1);

    expect(await assistantBriefRepository.findDueReminders('owner', after, 12)).toEqual([]);
    expect(await assistantBriefRepository.findEarliestPendingReminderAt('owner')).toBeNull();
    await assistantBriefRepository.resolveFollowUpDecision(id, 'owner', 'fu-reminder-1', 'approved', NOW);
    expect(await assistantBriefRepository.findEarliestPendingReminderAt('owner')).toEqual(REMIND_AT);
    expect(await assistantBriefRepository.findDueReminders('owner', new Date(REMIND_AT.getTime() - 1), 12)).toEqual([]);

    const due = await assistantBriefRepository.findDueReminders('owner', after, 12);
    expect(due).toEqual([
      { briefId: id, decisionId: 'fu-reminder-1', text: 'Remind me: call back', remindAt: REMIND_AT },
    ]);
    await assistantBriefRepository.markRemindersSurfaced('owner', due, after);
    expect(await assistantBriefRepository.findDueReminders('owner', after, 12)).toEqual([]);
    expect(await assistantBriefRepository.findEarliestPendingReminderAt('owner')).toBeNull();
  });

  it('finds the next reminder strictly after a given instant', async () => {
    const id = await createFollowUpBrief();
    await assistantBriefRepository.resolveFollowUpDecision(id, 'owner', 'fu-reminder-1', 'approved', NOW);
    expect(await assistantBriefRepository.findEarliestPendingReminderAt('owner', NOW)).toEqual(REMIND_AT);
    expect(await assistantBriefRepository.findEarliestPendingReminderAt('owner', REMIND_AT)).toBeNull();
  });

  it('approves only while the validated recipient and time are unchanged', async () => {
    const id = await createFollowUpBrief();
    const approve = (decisionId: string, expected: { to?: string; remindAt?: Date }) =>
      assistantBriefRepository.resolveFollowUpDecision(id, 'owner', decisionId, 'approved', NOW, expected);

    expect(await approve('fu-email', { to: 'sam@example.com' })).toBe(false);
    expect(await approve('fu-reminder-1', { remindAt: new Date(REMIND_AT.getTime() + 60_000) })).toBe(false);
    expect(await approve('fu-email', { to: 'Sam' })).toBe(true);
    expect(await approve('fu-reminder-1', { remindAt: REMIND_AT })).toBe(true);
  });

  it('lists activity briefs only, so a memo never becomes the latest brief', async () => {
    const memoId = await createFollowUpBrief();
    const activity = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: NOW,
      periodEnd: NOW,
    });

    const listed = await assistantBriefRepository.listByUser('owner', 20);
    expect(listed.map(brief => String(brief._id))).toEqual([String(activity._id)]);
    expect(listed.map(brief => String(brief._id))).not.toContain(memoId);
  });

  it('expires an unsettled memo row through a TTL index and drops the expiry on settle', async () => {
    const before = Date.now();
    const composing = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: NOW,
      periodEnd: NOW,
      origin: 'followUp',
      followUpInput: { transcript: 'memo' },
    });
    const expiresAt = (await assistantBriefRepository.findById(String(composing._id)))?.followUpInput?.expiresAt;
    expect(expiresAt?.getTime()).toBeGreaterThanOrEqual(before + FOLLOW_UP_COMPOSING_TTL_MS);
    expect(AssistantBriefModel.schema.indexes()).toContainEqual([
      { 'followUpInput.expiresAt': 1 },
      expect.objectContaining({ expireAfterSeconds: 0 }),
    ]);

    await assistantBriefRepository.markFailed(String(composing._id), 'composition_failed');
    expect((await assistantBriefRepository.findById(String(composing._id)))?.followUpInput).toBeUndefined();
  });

  it('stores a narrowed window when settled with periodEnd', async () => {
    const start = new Date(NOW.getTime() - 60_000);
    const brief = await assistantBriefRepository.createComposing({
      userId: 'owner',
      periodStart: start,
      periodEnd: NOW,
    });
    await assistantBriefRepository.markReady(String(brief._id), followUpContent, NOW, { periodEnd: start });
    expect((await assistantBriefRepository.findById(String(brief._id)))?.periodEnd).toEqual(start);
  });
});
