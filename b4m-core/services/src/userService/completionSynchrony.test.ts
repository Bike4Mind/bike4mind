import { describe, expect, it } from 'vitest';
import { findCompletionSynchrony, type CompletionSynchronyEvent } from './completionSynchrony';

const base = Date.parse('2026-01-01T12:00:00Z');
const members = ['account-a', 'account-b', 'account-c'];
const burst = (second: number, model = 'model-alpha', order = members): CompletionSynchronyEvent[] =>
  order.map((userId, i) => ({
    eventId: `${second}-${userId}`,
    userId,
    at: new Date(base + second * 1000 + i * 200),
    requestedModel: model,
    outcome: 'completed',
  }));
const repeated = () => [...burst(0), ...burst(120), ...burst(240, 'model-beta')];

describe('completion start synchrony', () => {
  it('discovers unknown accounts and shared model switches without requiring the same order', () => {
    const result = findCompletionSynchrony([
      ...burst(0),
      ...burst(120, 'model-alpha', [...members].reverse()),
      ...burst(240, 'model-beta'),
    ]);
    expect(result.truncated).toBe(false);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]).toMatchObject({
      userIds: members,
      bursts: 3,
      synchronizedModelSwitches: 1,
      distinctRequestedModels: 2,
      maxStartSkewMilliseconds: 400,
      completedRequests: 9,
    });
  });
  it('finds a recurring subset despite different incidental accounts in each burst', () => {
    const events = [0, 120, 240].flatMap((second, i) => [
      ...burst(second, i === 2 ? 'model-beta' : 'model-alpha'),
      {
        ...burst(second, i === 2 ? 'model-beta' : 'model-alpha')[0],
        eventId: `noise-${i}`,
        userId: `unrelated-${i}`,
        at: new Date(base + second * 1000 + 600),
      },
    ]);
    expect(findCompletionSynchrony(events).patterns).toMatchObject([
      { userIds: members, bursts: 3, synchronizedModelSwitches: 1 },
    ]);
  });

  it('accepts simultaneous starts without inventing an order', () => {
    const events = repeated().map(event => ({ ...event, at: new Date(Math.floor(event.at.getTime() / 1000) * 1000) }));
    expect(findCompletionSynchrony(events).patterns[0].maxStartSkewMilliseconds).toBe(0);
  });
  it('keeps independent requests for one account out of the member count', () => {
    expect(findCompletionSynchrony(repeated().map(event => ({ ...event, userId: 'same-account' }))).patterns).toEqual(
      []
    );
  });
  it('requires at least three disjoint bursts', () => {
    expect(findCompletionSynchrony([...burst(0), ...burst(120)]).patterns).toEqual([]);
    expect(findCompletionSynchrony([...burst(0), ...burst(0), ...burst(0)]).patterns).toEqual([]);
  });
  it('does not turn unrelated requested models into a synchronized burst', () => {
    expect(
      findCompletionSynchrony(repeated().map(event => ({ ...event, requestedModel: event.userId }))).patterns
    ).toEqual([]);
  });
  it('does not stitch bursts separated by a long gap', () => {
    expect(findCompletionSynchrony([...burst(0), ...burst(4000), ...burst(8000)]).patterns).toEqual([]);
  });
  it('does not treat matching per-account counts as synchronized timing', () => {
    expect(
      findCompletionSynchrony(
        repeated().map(event => ({
          ...event,
          at: new Date(event.at.getTime() + members.indexOf(event.userId) * 10_000),
        }))
      ).patterns
    ).toEqual([]);
  });
  it('counts cap-rejected attempts separately from successful calls', () => {
    const events = repeated().map(event => ({
      ...event,
      outcome: event.userId === members[0] ? ('daily_cap_rejected' as const) : ('completed' as const),
    }));
    expect(findCompletionSynchrony(events).patterns[0]).toMatchObject({
      completedRequests: 6,
      dailyCapRejectedRequests: 3,
    });
  });
  it('retains interrupted and unknown outcomes without assuming HTTP success', () => {
    expect(
      findCompletionSynchrony(repeated().map(event => ({ ...event, outcome: 'interrupted' }))).patterns[0]
    ).toMatchObject({ completedRequests: 0, interruptedOrUnknownRequests: 9 });
  });
  it('does not let removed participants complete a cohort', () => {
    expect(
      findCompletionSynchrony(repeated().map(event => ({ ...event, eligible: event.userId !== members[0] }))).patterns
    ).toEqual([]);
  });
  it('is deterministic for shuffled source rows and deduplicates immutable event identities', () => {
    const events = repeated();
    expect(findCompletionSynchrony([...events, ...events].reverse())).toEqual(findCompletionSynchrony(events));
  });
  it('keeps legitimate team automation as coordination evidence without an abuse verdict', () => {
    const result = findCompletionSynchrony(repeated());
    expect(result.patterns[0]).not.toHaveProperty('verdict');
    expect(result.patterns[0]).not.toHaveProperty('confidence');
  });
  it('reports bounded processing instead of implying a clean platform', () => {
    const events = Array.from({ length: 5001 }, (_, i) => ({
      ...burst(0)[0],
      eventId: `event-${i}`,
      userId: `account-${i}`,
    }));
    expect(findCompletionSynchrony(events).truncated).toBe(true);
  });
});
