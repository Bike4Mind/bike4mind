import { describe, it, expect } from 'vitest';
import { requireNonSystemUser } from '../requireNonSystemUser';

describe('requireNonSystemUser', () => {
  it('throws ForbiddenError for system users', () => {
    expect(() => requireNonSystemUser({ isSystem: true })).toThrow('Cannot authenticate as a system account');
  });

  it('returns user unchanged when isSystem is false', () => {
    const user = { isSystem: false, id: 'u1' };
    expect(requireNonSystemUser(user)).toBe(user);
  });

  it('returns user unchanged when isSystem is undefined', () => {
    const user = { isSystem: undefined, id: 'u1' };
    expect(requireNonSystemUser(user as any)).toBe(user);
  });

  it('preserves all user fields on pass-through', () => {
    const user = { isSystem: false, id: 'u1', email: 'a@b.com', name: 'Alice' };
    const result = requireNonSystemUser(user);
    expect(result).toEqual(user);
  });
});
