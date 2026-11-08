import { describe, expect, it } from 'vitest';
import { findCompletionSequences, type CompletionSequenceEvent } from './completionSequences';

const base = Date.parse('2026-01-01T00:00:00Z');
const event = (userId: string, seconds: number, requestId = `${userId}-${seconds}`): CompletionSequenceEvent => ({
  userId,
  requestId,
  at: new Date(base + seconds * 1_000),
});
const round = (members: string[], start: number) => members.map((id, index) => event(id, start + index));
const members = ['account-a', 'account-b', 'account-c', 'account-d'];

describe('completion ordering regression cases', () => {
  it('discovers a previously unknown cohort and suppresses overlapping shorter sequences', () => {
    const result = findCompletionSequences([...round(members, 0), ...round(members, 360)]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      userIds: members,
      rounds: 2,
      minRequestsPerRound: 4,
      maxRequestsPerRound: 4,
    });
    expect(result.truncated).toBe(false);
  });
  it('is deterministic when input rows arrive out of order', () => {
    const rows = [...round(members, 0), ...round(members, 360)];
    expect(findCompletionSequences([...rows].reverse())).toEqual(findCompletionSequences(rows));
  });
  it('does not turn equal counts with different ordering into coordination', () => {
    expect(findCompletionSequences([...round(members, 0), ...round([...members].reverse(), 360)]).patterns).toEqual([]);
  });
  it.each([['account-a', 'account-b'], members])('requires three accounts and repeated rounds (%j)', (...ids) => {
    const rows = ids.length < 3 ? [...round(ids, 0), ...round(ids, 360)] : round(ids, 0);
    expect(findCompletionSequences(rows).patterns).toEqual([]);
  });
  it('does not stitch distant episodes together', () => {
    expect(findCompletionSequences([...round(members, 0), ...round(members, 4_000)]).patterns).toEqual([]);
  });
  it('does not invent ordering for simultaneous observations', () => {
    const result = findCompletionSequences([0, 360].flatMap(start => members.map(id => event(id, start))));
    expect(result.patterns).toEqual([]);
    expect(result.ambiguousTimestamps).toBe(true);
  });
  it('counts a request once when multiple ledger rows report it', () => {
    const rows = [...round(members, 0), ...round(members, 360)];
    const result = findCompletionSequences([
      ...rows,
      ...rows.map(row => ({ ...row, at: new Date(row.at.getTime() + 100) })),
    ]);
    expect(result.patterns[0]).toMatchObject({ rounds: 2, minRequestsPerRound: 4, maxRequestsPerRound: 4 });
  });
  it('retains unrelated and excluded traffic as boundaries', () => {
    const rows = [0, 360].flatMap(start => [
      event('a', start),
      event('b', start + 1),
      { ...event(`excluded-${start}`, start + 2), eligible: false },
      event('c', start + 3),
      event('d', start + 4),
    ]);
    expect(findCompletionSequences(rows).patterns).toEqual([]);
    expect(findCompletionSequences(rows.map(row => ({ ...row, eligible: true }))).patterns).toEqual([]);
  });
  it('supports small per-account batches', () => {
    const rows = [0, 360].flatMap(start =>
      ['a', 'b', 'c'].flatMap((id, index) => [event(id, start + index * 3), event(id, start + index * 3 + 1)])
    );
    expect(findCompletionSequences(rows).patterns[0]).toMatchObject({
      rounds: 2,
      minRequestsPerRound: 6,
      maxRequestsPerRound: 6,
    });
  });
  it('recognizes legitimate scheduled workflows as coordination without assigning an abuse verdict', () => {
    const result = findCompletionSequences([0, 360, 720].flatMap(start => round(members, start)));
    expect(result.patterns[0].rounds).toBe(3);
    expect(result.patterns[0]).not.toHaveProperty('abuseProbability');
    expect(result.patterns[0]).not.toHaveProperty('verdict');
  });
  it('reports candidate-work caps rather than claiming complete coverage', () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => event(`user-${index}`, index));
    expect(findCompletionSequences(rows).truncated).toBe(true);
  });
});
