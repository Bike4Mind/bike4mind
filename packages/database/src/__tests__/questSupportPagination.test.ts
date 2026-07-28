import { describe, it, expect, beforeEach } from 'vitest';
import { Quest, questRepository } from '../models/content/QuestModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

const SESSION = 'sess-support-1';

/** Six turns, one minute apart, so ordering is unambiguous. */
async function seedTurns(count: number) {
  for (let i = 0; i < count; i += 1) {
    await Quest.create({
      sessionId: SESSION,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)),
      type: 'message',
      prompt: `prompt ${i}`,
      reply: `reply ${i}`,
      structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'bulky' }] }],
    });
  }
}

beforeEach(async () => {
  await Quest.deleteMany({});
});

describe('questRepository.findPageBySessionId', () => {
  it('pages oldest-first and reports hasMore without leaking the probe row', async () => {
    await seedTurns(6);

    const first = await questRepository.findPageBySessionId(SESSION, { page: 1, limit: 2 });
    expect(first.data.map(q => q.prompt)).toEqual(['prompt 0', 'prompt 1']);
    expect(first.hasMore).toBe(true);

    const last = await questRepository.findPageBySessionId(SESSION, { page: 3, limit: 2 });
    expect(last.data.map(q => q.prompt)).toEqual(['prompt 4', 'prompt 5']);
    expect(last.hasMore).toBe(false);
  });

  it('honours newest-first', async () => {
    await seedTurns(3);
    const page = await questRepository.findPageBySessionId(SESSION, { page: 1, limit: 2, sort: 'desc' });
    expect(page.data.map(q => q.prompt)).toEqual(['prompt 2', 'prompt 1']);
    expect(page.hasMore).toBe(true);
  });

  it('projects only the conversation fields - bulk payloads stay out', async () => {
    await seedTurns(1);
    const page = await questRepository.findPageBySessionId(SESSION, { page: 1, limit: 10 });
    expect(page.data[0].prompt).toBe('prompt 0');
    expect(page.data[0].structuredReplies).toBeUndefined();
  });

  it('excludes soft-deleted turns and other sessions', async () => {
    await seedTurns(2);
    await Quest.create({
      sessionId: 'someone-else',
      timestamp: new Date(),
      type: 'message',
      prompt: 'not mine',
    });
    await Quest.updateOne({ sessionId: SESSION, prompt: 'prompt 0' }, { $set: { deletedAt: new Date() } });

    const page = await questRepository.findPageBySessionId(SESSION, { page: 1, limit: 10 });
    expect(page.data.map(q => q.prompt)).toEqual(['prompt 1']);
    expect(page.hasMore).toBe(false);
  });

  it('returns an empty page past the end', async () => {
    await seedTurns(2);
    const page = await questRepository.findPageBySessionId(SESSION, { page: 5, limit: 10 });
    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
