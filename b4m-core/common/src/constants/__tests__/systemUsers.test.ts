import { describe, it, expect } from 'vitest';
import { OVERWATCH_SYSTEM_USER_EMAIL } from '../systemUsers';

describe('OVERWATCH_SYSTEM_USER_EMAIL', () => {
  it('has the expected value', () => {
    expect(OVERWATCH_SYSTEM_USER_EMAIL).toBe('overwatch-system@system.bike4mind.invalid');
  });

  it('uses a .invalid TLD (RFC 6761 — physically unroutable)', () => {
    expect(OVERWATCH_SYSTEM_USER_EMAIL).toMatch(/\.invalid$/);
  });
});
