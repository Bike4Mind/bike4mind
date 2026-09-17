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
        promptMeta: { session: { id: SESSION, userId: 'owner-1' }, model: 'PRIVATE TOOL OUTPUT' },
        toolResults: [{ tool_use_id: 'tu-1', content: 'SECRET TOOL RESULT' }],
      })
    );

    const [link] = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(link).toBeDefined();
    expect(link.prompt).toBe('no, it was Tuesday');
    expect(link.reply).toBe('second answer');
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

  it('exposes _id as a string id the walk can match correctsQuestId against', async () => {
    const root = await Quest.create(seed({ prompt: 'first ask' }));
    await Quest.create(seed({ correctsQuestId: root._id.toString(), prompt: 'the retry' }));

    const [link] = await questRepository.findCorrectionLinksBySessionId(SESSION);

    expect(typeof link.id).toBe('string');
    expect(link.correctsQuestId).toBe(root._id.toString());
    expect(mongoose.isValidObjectId(link.id)).toBe(true);
  });
});
