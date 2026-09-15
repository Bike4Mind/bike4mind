/**
 * Deterministic bcryptjs stub used in userApiKeyService tests.
 *
 * Skips real bcrypt rounds (12 = ~150-300ms each) while preserving the
 * matching/non-matching invariant the round-trip tests actually verify:
 *   compare(k, hashSync(k))      === true
 *   compare(k, hashSync(otherK)) === false
 *
 * Usage (must be a hoisted-safe async factory because vi.mock is hoisted
 * above imports):
 *
 *   vi.mock('bcryptjs', async () => {
 *     const { bcryptMockFactory } = await import('./helpers/bcryptMock');
 *     return bcryptMockFactory();
 *   });
 */
export const bcryptMockFactory = () => ({
  default: {
    hashSync: (key: string) => `__h__:${key}`,
    compare: (key: string, hash: string) => Promise.resolve(hash === `__h__:${key}`),
  },
});
