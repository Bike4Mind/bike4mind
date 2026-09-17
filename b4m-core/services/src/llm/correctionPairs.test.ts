import { describe, it, expect, vi } from 'vitest';
import { buildCorrectionPairs, type CorrectionPairReader, type CorrectionTurnRecord } from './correctionPairs';

const SESSION = 'session-1';

function turn(over: Partial<CorrectionTurnRecord> & { id: string }): CorrectionTurnRecord {
  return { sessionId: SESSION, prompt: `prompt ${over.id}`, reply: `answer ${over.id}`, ...over };
}

/** In-memory stand-in for QuestRepository: links come back oldest first, as the query sorts them. */
function fakeReader(records: CorrectionTurnRecord[]): CorrectionPairReader & { findById: ReturnType<typeof vi.fn> } {
  const byId = new Map(records.map(r => [r.id, r]));
  return {
    findCorrectionLinks: async sessionId => records.filter(r => r.sessionId === sessionId && r.correctsQuestId),
    findById: vi.fn(async (id: string) => byId.get(id) ?? null),
  };
}

describe('buildCorrectionPairs', () => {
  it('emits one triple per hop of a two-link chain, oldest first', async () => {
    const reader = fakeReader([
      turn({ id: 'A' }),
      turn({ id: 'B', correctsQuestId: 'A' }),
      turn({ id: 'C', correctsQuestId: 'B' }),
    ]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs).toEqual([
      {
        correctedQuestId: 'A',
        originalAnswer: 'answer A',
        critique: 'prompt B',
        correctedAnswer: 'answer B',
        timestamp: undefined,
      },
      {
        correctedQuestId: 'B',
        originalAnswer: 'answer B',
        critique: 'prompt C',
        correctedAnswer: 'answer C',
        timestamp: undefined,
      },
    ]);
  });

  it('terminates on a cyclic chain', async () => {
    const reader = fakeReader([turn({ id: 'X', correctsQuestId: 'Y' }), turn({ id: 'Y', correctsQuestId: 'X' })]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs.map(p => p.correctedQuestId)).toEqual(['Y', 'X']);
  });

  it('drops a self-referential link rather than pairing a turn with itself', async () => {
    const reader = fakeReader([turn({ id: 'Z', correctsQuestId: 'Z' })]);

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
  });

  it('drops a hop whose target belongs to another session', async () => {
    const reader = fakeReader([
      turn({ id: 'other', sessionId: 'session-2' }),
      turn({ id: 'B', correctsQuestId: 'other' }),
    ]);

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
  });

  // Built by hand rather than through fakeReader, whose findCorrectionLinks filters on sessionId
  // and so can never hand back a link that has none. This is the row a reject-on-mismatch guard
  // (`target.sessionId !== current.sessionId`) would let through, which is what the positive form
  // in buildCorrectionPairs exists to stop; invert that guard and this test is the one that fails.
  it('drops a hop when neither turn records a session', async () => {
    const orphan = { id: 'orphan', prompt: 'p', reply: 'a' } as unknown as CorrectionTurnRecord;
    const link = { id: 'B', correctsQuestId: 'orphan', prompt: 'p', reply: 'a' } as unknown as CorrectionTurnRecord;
    const reader: CorrectionPairReader = {
      findCorrectionLinks: async () => [link],
      findById: async id => (id === 'orphan' ? orphan : null),
    };

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
  });

  it('skips a hop whose corrected turn never recorded an answer, and keeps walking past it', async () => {
    const reader = fakeReader([
      turn({ id: 'A', reply: null }),
      turn({ id: 'B', correctsQuestId: 'A' }),
      turn({ id: 'C', correctsQuestId: 'B' }),
    ]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs.map(p => p.correctedQuestId)).toEqual(['B']);
  });

  it('reads structured assistant text ahead of the flat reply', async () => {
    const reader = fakeReader([
      turn({
        id: 'A',
        structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'structured A' }] }],
      }),
      turn({ id: 'B', correctsQuestId: 'A' }),
    ]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs[0]?.originalAnswer).toBe('structured A');
  });

  it('returns an empty list for a session with no links, without reading any quest', async () => {
    const reader = fakeReader([turn({ id: 'A' })]);

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
    expect(reader.findById).not.toHaveBeenCalled();
  });

  it('returns an empty list for an absent session id', async () => {
    const reader = fakeReader([turn({ id: 'B', correctsQuestId: 'A' })]);

    await expect(buildCorrectionPairs(undefined, reader)).resolves.toEqual([]);
    await expect(buildCorrectionPairs('', reader)).resolves.toEqual([]);
  });
});
