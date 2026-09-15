import { describe, expect, it } from 'vitest';
import { DataSubscribeRequestAction } from './actions';

/**
 * Pins the WIRING, not the allow-list itself (subscriptionQueryFilter.test.ts covers that):
 * the refusal has to happen at `DataSubscribeRequestAction.parse`, because that is the only
 * point in the WS data-subscribe path that runs before both the initial `Model.find` and the
 * `QuerySubscription` write the fanout service replays.
 */
const frame = (query: Record<string, unknown>) => ({
  action: 'subscribe_query',
  subscriptionId: 'sub-1',
  collectionName: 'users',
  query,
  fields: {},
});

describe('DataSubscribeRequestAction query filter gate', () => {
  it('accepts an ordinary equality filter', () => {
    expect(DataSubscribeRequestAction.parse(frame({ sessionId: 'abc' })).query).toEqual({ sessionId: 'abc' });
  });

  it('refuses a filter that asks the database to run JavaScript', () => {
    expect(() => DataSubscribeRequestAction.parse(frame({ $where: 'while(true){}' }))).toThrow(
      /Disallowed subscription filter/
    );
  });

  it('refuses a disallowed operator nested inside an allowed combinator', () => {
    expect(() =>
      DataSubscribeRequestAction.parse(frame({ $and: [{ userId: 'u1' }, { $expr: { $function: { body: 'x' } } }] }))
    ).toThrow(/Disallowed subscription filter/);
  });
});
