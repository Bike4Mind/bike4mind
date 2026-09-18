import { describe, it, expect, vi } from 'vitest';
import { buildCorrectionPairs, type CorrectionPairReader, type CorrectionTurnRecord } from './correctionPairs';

const SESSION = 'session-1';

// Realistic 24-char hex ids so uppercase-hex spellings exercise the same cast Mongo does; a
// bare letter id (used by the other cases below) never round-trips through a case-fold.
const ID_A = '507f1f77bcf86cd799439011';
const ID_A_UPPER = ID_A.toUpperCase();
const ID_B = '507f191e810c19729de860ea';

function turn(over: Partial<CorrectionTurnRecord> & { id: string }): CorrectionTurnRecord {
  return { sessionId: SESSION, prompt: `prompt ${over.id}`, reply: `answer ${over.id}`, ...over };
}

/**
 * In-memory stand-in for QuestRepository: links come back oldest first, as the query sorts them.
 * `findByIds` resolves case-insensitively on the hex, mirroring how an ObjectId cast resolves a
 * non-canonical spelling to the same stored document.
 */
function fakeReader(records: CorrectionTurnRecord[]): CorrectionPairReader & { findByIds: ReturnType<typeof vi.fn> } {
  return {
    findCorrectionLinks: async sessionId => records.filter(r => r.sessionId === sessionId && r.correctsQuestId),
    findByIds: vi.fn(async (ids: string[]) =>
      ids
        .map(id => records.find(r => r.id.toLowerCase() === id.toLowerCase()))
        .filter((r): r is CorrectionTurnRecord => Boolean(r))
    ),
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

  // The closing hop is dropped rather than emitted: in a cycle the same answer would appear as
  // both the original and the correction, which is fabricated eval data, not a retry.
  it('stops a cyclic chain at the hop that would close it', async () => {
    const reader = fakeReader([turn({ id: 'X', correctsQuestId: 'Y' }), turn({ id: 'Y', correctsQuestId: 'X' })]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs.map(p => p.correctedQuestId)).toEqual(['Y']);
  });

  it('drops a hop whose correction says nothing about what was wrong', async () => {
    const reader = fakeReader([turn({ id: 'A' }), turn({ id: 'B', correctsQuestId: 'A', prompt: '   ' })]);

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
  });

  it('warns on every dropped hop, since the only other symptom is a shorter export', async () => {
    const warn = vi.fn();
    const reader = {
      ...fakeReader([turn({ id: 'other', sessionId: 'session-2' }), turn({ id: 'B', correctsQuestId: 'other' })]),
      logger: { warn },
    };

    await buildCorrectionPairs(SESSION, reader);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('cross-session');
  });

  it('drops a self-referential link rather than pairing a turn with itself', async () => {
    const reader = fakeReader([turn({ id: 'Z', correctsQuestId: 'Z' })]);

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
  });

  // The raw path.has(targetId) fast check never fires here (different case), so this is the
  // canonical-id re-check after resolution that has to catch it instead.
  it('drops an uppercase-hex self-link rather than pairing a turn with itself', async () => {
    const warn = vi.fn();
    const reader = {
      ...fakeReader([turn({ id: ID_A, correctsQuestId: ID_A_UPPER })]),
      logger: { warn },
    };

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
    expect(warn.mock.calls.some(c => String(c[0]).includes('cyclic'))).toBe(true);
  });

  it('resolves an uppercase-hex link to a different turn and still emits its pair', async () => {
    const reader = fakeReader([turn({ id: ID_A }), turn({ id: ID_B, correctsQuestId: ID_A_UPPER })]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs).toEqual([
      {
        correctedQuestId: ID_A,
        originalAnswer: `answer ${ID_A}`,
        critique: `prompt ${ID_B}`,
        correctedAnswer: `answer ${ID_B}`,
        timestamp: undefined,
      },
    ]);
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
      findByIds: async ids => (ids.includes('orphan') ? [orphan] : []),
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
    expect(reader.findByIds).not.toHaveBeenCalled();
  });

  it('returns an empty list for an absent session id', async () => {
    const reader = fakeReader([turn({ id: 'B', correctsQuestId: 'A' })]);

    await expect(buildCorrectionPairs(undefined, reader)).resolves.toEqual([]);
    await expect(buildCorrectionPairs('', reader)).resolves.toEqual([]);
  });

  // Regression guard for the N-round-trip bug: every chain root gets resolved off one batched
  // read, not one read per root awaited inside the walk.
  it('calls findByIds at most once across a whole build, even with several distinct roots', async () => {
    const reader = fakeReader([
      turn({ id: 'root1' }),
      turn({ id: 'link1', correctsQuestId: 'root1' }),
      turn({ id: 'root2' }),
      turn({ id: 'link2', correctsQuestId: 'root2' }),
      turn({ id: 'root3' }),
      turn({ id: 'link3', correctsQuestId: 'root3' }),
    ]);

    const pairs = await buildCorrectionPairs(SESSION, reader);

    expect(pairs).toHaveLength(3);
    expect(reader.findByIds).toHaveBeenCalledTimes(1);
  });

  it('drops a hop whose chain root findByIds does not return', async () => {
    const warn = vi.fn();
    const reader = {
      ...fakeReader([turn({ id: 'B', correctsQuestId: 'missing-root' })]),
      logger: { warn },
    };

    await expect(buildCorrectionPairs(SESSION, reader)).resolves.toEqual([]);
    expect(warn.mock.calls.some(c => String(c[0]).includes('gone'))).toBe(true);
  });
});
