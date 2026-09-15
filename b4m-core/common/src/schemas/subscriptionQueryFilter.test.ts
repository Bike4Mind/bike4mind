import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_FILTER_MAX_DEPTH, findDisallowedSubscriptionFilterKeys } from './subscriptionQueryFilter';

describe('findDisallowedSubscriptionFilterKeys', () => {
  it('accepts the filter shapes real subscriptions send', () => {
    expect(findDisallowedSubscriptionFilterKeys({})).toEqual([]);
    expect(findDisallowedSubscriptionFilterKeys({ sessionId: 'abc123' })).toEqual([]);
    expect(findDisallowedSubscriptionFilterKeys({ _id: { $in: ['a', 'b'] } })).toEqual([]);
    expect(
      findDisallowedSubscriptionFilterKeys({
        $or: [{ userId: 'u1' }, { createdAt: { $gte: '2026-01-01', $lt: '2026-02-01' } }],
      })
    ).toEqual([]);
  });

  it('rejects the server-side JavaScript operators', () => {
    expect(findDisallowedSubscriptionFilterKeys({ $where: 'while(true){}' })).toEqual(['$where']);
    expect(findDisallowedSubscriptionFilterKeys({ $expr: { $function: { body: 'x' } } })).toEqual(['$expr']);
  });

  it('rejects unbounded matching operators', () => {
    expect(findDisallowedSubscriptionFilterKeys({ email: { $regex: '(a+)+$', $options: 'i' } })).toEqual([
      'email.$regex',
      'email.$options',
    ]);
    expect(findDisallowedSubscriptionFilterKeys({ $text: { $search: 'x' } })).toEqual(['$text']);
    expect(findDisallowedSubscriptionFilterKeys({ $jsonSchema: {} })).toEqual(['$jsonSchema']);
  });

  it('finds a disallowed operator nested inside an allowed combinator', () => {
    // The dangerous key is reachable through any allow-listed operand, so the scan must recurse
    // rather than only inspecting top-level keys.
    expect(findDisallowedSubscriptionFilterKeys({ $and: [{ userId: 'u1' }, { $where: 'sleep(9e9)' }] })).toEqual([
      '$and[1].$where',
    ]);
    expect(findDisallowedSubscriptionFilterKeys({ tags: { $elemMatch: { $where: '1' } } })).toEqual([
      'tags.$elemMatch.$where',
    ]);
  });

  it('rejects a RegExp operand a same-process caller could construct', () => {
    expect(findDisallowedSubscriptionFilterKeys({ name: /(a+)+$/ })).toEqual(['name (regular expression)']);
  });

  it('rejects nesting past the depth bound instead of recursing on it', () => {
    let deep: Record<string, unknown> = { userId: 'u1' };
    for (let i = 0; i <= SUBSCRIPTION_FILTER_MAX_DEPTH; i++) deep = { $and: [deep] };
    expect(findDisallowedSubscriptionFilterKeys(deep).length).toBeGreaterThan(0);
  });

  it('reports every violation, not just the first', () => {
    expect(findDisallowedSubscriptionFilterKeys({ $where: 'a', $expr: 'b' })).toEqual(['$where', '$expr']);
  });
});
