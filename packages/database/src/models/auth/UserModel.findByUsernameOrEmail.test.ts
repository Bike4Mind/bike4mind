import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await User.syncIndexes();
});

/**
 * Regression coverage for the regex-injection / ReDoS hardening.
 *
 * `findByUsernameOrEmail` backs auth/registration lookups, so its `username` /
 * `email` operands must never behave as attacker-controlled `$regex` patterns.
 * These tests assert behaviour, not implementation: the lookup is an exact,
 * case-insensitive match, wildcards/anchors are treated literally, and a
 * catastrophic-backtracking payload resolves fast. Callers must pass RAW input
 * (this layer owns the escaping); pre-escaping at a call site double-escapes.
 */
describe('UserModel.findByUsernameOrEmail — regex-injection hardening (#9738)', () => {
  it('matches an exact username case-insensitively', async () => {
    await User.create({ username: 'Alice', name: 'Alice', email: 'alice@example.com' });

    const found = await userRepository.findByUsernameOrEmail('alice', 'alice');
    expect(found?.username).toBe('Alice');
  });

  it('matches an exact email case-insensitively', async () => {
    await User.create({ username: 'bob', name: 'Bob', email: 'Bob@Example.com' });

    const found = await userRepository.findByUsernameOrEmail('bob@example.com', 'bob@example.com');
    expect(found?.email).toBe('Bob@Example.com');
  });

  it('does NOT treat a wildcard payload as a pattern (query manipulation)', async () => {
    await User.create({ username: 'charlie', name: 'Charlie', email: 'charlie@example.com' });

    // `.*` previously matched every username/email; escaped it matches only a
    // literal ".*", which no real account has.
    const found = await userRepository.findByUsernameOrEmail('.*', '.*');
    expect(found).toBeNull();
  });

  it('does NOT partial-match a username prefix (anchoring)', async () => {
    await User.create({ username: 'administrator', name: 'Admin', email: 'admin@example.com' });

    // Unanchored, `$regex: 'admin'` would match 'administrator'. Anchored, it
    // must not - login must be exact.
    const found = await userRepository.findByUsernameOrEmail('admin', 'admin');
    expect(found).toBeNull();
  });

  it('resolves quickly for a catastrophic-backtracking ReDoS payload', async () => {
    await User.create({ username: 'dave', name: 'Dave', email: 'dave@example.com' });

    // A crafted pattern like `(a+)+$` against a long candidate would pin an
    // unescaped $regex. Escaped, this is a literal lookup that returns fast.
    const start = Date.now();
    const found = await userRepository.findByUsernameOrEmail('(a+)+$', '(a+)+$');
    const elapsedMs = Date.now() - start;

    expect(found).toBeNull();
    expect(elapsedMs).toBeLessThan(1000);
  });
});
