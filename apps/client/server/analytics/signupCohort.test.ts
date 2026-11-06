import { describe, it, expect } from 'vitest';
import { isActiveEligible, isCountedUser, type CountingContext } from './signupCohort';

const ctx: CountingContext = { staffRegex: /@staff\.example\.com$/i, testDomains: ['e2e.example.test'] };
const plain = { _id: 'u', email: 'a@customer.example.com', username: 'alice' };

describe('isCountedUser', () => {
  it.each([
    ['admin', { isAdmin: true }],
    ['system', { isSystem: true }],
    ['synthetic', { isSynthetic: true }],
    ['staff domain', { email: 'dev@staff.example.com' }],
    ['Developer tag', { tags: ['Developer'] }],
    ['dev tag', { tags: ['dev'] }],
    ['developers tag', { tags: ['developers'] }],
    ['persona username', { username: 'persona-checkout' }],
    ['test-domain email', { email: 'x@sub.e2e.example.test' }],
  ])('excludes a %s account', (_name, extra) => {
    expect(isCountedUser({ ...plain, ...extra }, ctx)).toBe(false);
  });

  it('counts a plain user, an unrelated tag and an orphaned id', () => {
    expect(isCountedUser(plain, ctx)).toBe(true);
    expect(isCountedUser({ ...plain, tags: ['tavern'] }, ctx)).toBe(true);
    expect(isCountedUser(undefined, ctx)).toBe(true);
  });
});

describe('isActiveEligible', () => {
  it.each([
    ['banned', { isBanned: true }],
    ['moderated', { isModerated: true }],
    ['suspended', { moderation: { status: 'suspended' } }],
    ['review pending', { riskScore: { reviewState: 'pending' } }],
    ['dispute pending', { disputePending: true }],
    ['internal', { tags: ['Developer'] }],
  ])('rejects a %s account', (_name, extra) => {
    expect(isActiveEligible({ ...plain, ...extra }, ctx)).toBe(false);
  });

  it('accepts a throttled or suspend-pending account, a plain user and an orphaned id', () => {
    expect(isActiveEligible({ ...plain, moderation: { status: 'throttled' } }, ctx)).toBe(true);
    expect(isActiveEligible({ ...plain, moderation: { status: 'suspend_pending' } }, ctx)).toBe(true);
    expect(isActiveEligible(plain, ctx)).toBe(true);
    expect(isActiveEligible(undefined, ctx)).toBe(true);
  });
});
