import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Quest.deleteMany({});
});

const SESSION = 'session-1';

function seed(over: Record<string, unknown>) {
  return { sessionId: SESSION, type: 'chat', timestamp: new Date('2026-01-01T00:00:00Z'), ...over };
}

/**
 * Against a real schema rather than a mock, because what this query contributes IS the projection
 * and the filter: a mocked repository returns whatever the test hands it, so it can assert a
 * redaction the stored document never actually went through.
 */
describe('questRepository.findCorrectionLinksBySessionId', () => {
  it('returns prose and identity only - promptMeta and toolResults never leave the query', async () => {
    await Quest.create(
      seed({
        correctsQuestId: 'earlier',
        prompt: 'no, it was Tuesday',
        reply: 'second answer',
        replies: ['second answer', 'a follow-up part'],
        structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'second answer' }] }],
        promptMeta: { session: { id: SESSION, userId: 'owner-1' }, model: 'PRIVATE TOOL OUTPUT' },
        toolResults: [{ tool_use_id: 'tu-1', content: 'SECRET TOOL RESULT' }],
      })
    );

    const [link] = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(link).toBeDefined();
    expect(link.prompt).toBe('no, it was Tuesday');
    expect(link.reply).toBe('second answer');
    // Seeded so dropping either field from the allowlist fails here, not just silently in prod.
    // Mongoose auto-assigns each structuredReplies entry an _id as a subdocument, so compare
    // role/content rather than the whole object.
    expect(link.replies).toEqual(['second answer', 'a follow-up part']);
    expect(link.structuredReplies?.[0]?.role).toBe('assistant');
    expect(link.structuredReplies?.[0]?.content).toEqual([{ type: 'text', text: 'second answer' }]);
    // The allowlist, not a "does not contain promptMeta" spot check: drop the projection and every
    // other stored field (type, toolResults, __v, ...) shows up here, which is the whole point.
    const projected = [
      'id',
      'sessionId',
      'correctsQuestId',
      'prompt',
      'reply',
      'replies',
      'structuredReplies',
      'timestamp',
    ];
    expect(Object.keys(link).filter(k => !projected.includes(k))).toEqual([]);
    expect(JSON.stringify(link)).not.toContain('PRIVATE TOOL OUTPUT');
    expect(JSON.stringify(link)).not.toContain('SECRET TOOL RESULT');
  });

  it('excludes an empty-string correctsQuestId, not just null', async () => {
    await Quest.create(seed({ correctsQuestId: '', prompt: 'never actually corrected anything' }));
    await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'the only real correction' }));

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(links.map(l => l.prompt)).toEqual(['the only real correction']);
  });

  it('excludes uncorrected turns, soft-deleted turns, and turns from another session', async () => {
    await Quest.create(seed({ prompt: 'a first ask with no correction' }));
    await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'deleted', deletedAt: new Date() }));
    await Quest.create(seed({ sessionId: 'session-2', correctsQuestId: 'earlier', prompt: 'other notebook' }));
    await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'the only live correction' }));

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(links.map(l => l.prompt)).toEqual(['the only live correction']);
  });

  it('returns links oldest first', async () => {
    await Quest.create(
      seed({ correctsQuestId: 'earlier', prompt: 'later', timestamp: new Date('2026-01-03T00:00:00Z') })
    );
    await Quest.create(
      seed({ correctsQuestId: 'earlier', prompt: 'earlier', timestamp: new Date('2026-01-02T00:00:00Z') })
    );

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(links.map(l => l.prompt)).toEqual(['earlier', 'later']);
  });

  // Two turns can share a millisecond, and the walk pairs hops in the order it reads them, so the
  // `_id` tiebreak is the only thing making that order deterministic.
  it('breaks a timestamp tie on _id rather than leaving the order to the engine', async () => {
    const sameMoment = new Date('2026-01-02T00:00:00Z');
    const first = await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'first', timestamp: sameMoment }));
    const second = await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'second', timestamp: sameMoment }));

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(first._id.toString() < second._id.toString()).toBe(true);
    expect(links.map(l => l.prompt)).toEqual(['first', 'second']);
  });

  it('caps the read at the caller limit, so one export cannot pull a whole session', async () => {
    for (let i = 0; i < 4; i++) {
      await Quest.create(seed({ correctsQuestId: 'earlier', prompt: `c${i}`, timestamp: new Date(2026, 0, i + 1) }));
    }

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION, 2);

    expect(links.map(l => l.prompt)).toEqual(['c0', 'c1']);
  });

  it('treats a limit of 0 as "return nothing", not Mongo\'s "no limit"', async () => {
    await Quest.create(seed({ correctsQuestId: 'earlier', prompt: 'should not come back' }));

    const links = await questRepository.findCorrectionLinksBySessionId(SESSION, 0);

    expect(links).toEqual([]);
  });

  it('exposes _id as a string id the walk can match correctsQuestId against', async () => {
    const root = await Quest.create(seed({ prompt: 'first ask' }));
    await Quest.create(seed({ correctsQuestId: root._id.toString(), prompt: 'the retry' }));

    const [link] = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(typeof link.id).toBe('string');
    expect(link.correctsQuestId).toBe(root._id.toString());
    expect(mongoose.isValidObjectId(link.id)).toBe(true);
  });
});

describe('questRepository.findCorrectionTurnsByIds', () => {
  it('returns [] for an empty or undefined ids array without querying', async () => {
    await Quest.create(seed({ prompt: 'irrelevant' }));

    expect(await questRepository.findCorrectionTurnsByIds(SESSION, [])).toEqual([]);
    expect(await questRepository.findCorrectionTurnsByIds(SESSION, undefined as unknown as string[])).toEqual([]);
  });

  it('returns the requested turns, sharing the same projection as its sibling', async () => {
    const root = await Quest.create(
      seed({
        prompt: 'first ask',
        reply: 'first answer',
        replies: ['first answer'],
        structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }],
        promptMeta: { session: { id: SESSION, userId: 'owner-1' }, model: 'PRIVATE TOOL OUTPUT' },
      })
    );

    const [link] = await questRepository.findCorrectionTurnsByIds(SESSION, [root._id.toString()]);

    expect(link.id).toBe(root._id.toString());
    expect(link.prompt).toBe('first ask');
    expect(link.replies).toEqual(['first answer']);
    expect(link.structuredReplies?.[0]?.role).toBe('assistant');
    expect(link.structuredReplies?.[0]?.content).toEqual([{ type: 'text', text: 'first answer' }]);
    expect(JSON.stringify(link)).not.toContain('PRIVATE TOOL OUTPUT');
  });

  it('is scoped to the session and excludes soft-deleted turns', async () => {
    const own = await Quest.create(seed({ prompt: 'mine' }));
    const otherSession = await Quest.create(seed({ sessionId: 'session-2', prompt: 'not mine' }));
    const deleted = await Quest.create(seed({ prompt: 'gone', deletedAt: new Date() }));

    const links = await questRepository.findCorrectionTurnsByIds(SESSION, [
      own._id.toString(),
      otherSession._id.toString(),
      deleted._id.toString(),
    ]);

    expect(links.map(l => l.prompt)).toEqual(['mine']);
  });

  it('ignores an id that is not a valid ObjectId rather than throwing', async () => {
    const root = await Quest.create(seed({ prompt: 'valid one' }));

    const links = await questRepository.findCorrectionTurnsByIds(SESSION, ['not-an-object-id', root._id.toString()]);

    expect(links.map(l => l.prompt)).toEqual(['valid one']);
  });
});
