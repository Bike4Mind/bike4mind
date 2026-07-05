import { describe, it, expect } from 'vitest';
import { adminReturnValidationError, ADMIN_SESSION_EXPIRED, ADMIN_SESSION_VALIDATION_FAILED } from './user';

describe('adminReturnValidationError', () => {
  it('returns the force-logout sentinel for an auth rejection (401/403)', () => {
    expect(adminReturnValidationError(401, false)).toBe(ADMIN_SESSION_EXPIRED);
    expect(adminReturnValidationError(403, false)).toBe(ADMIN_SESSION_EXPIRED);
  });

  it('returns a transient, non-sentinel message for a 5xx / other non-OK (must NOT force a logout)', () => {
    // The load-bearing invariant: a 503 from /api/identify surfaces an error but does not
    // equal ADMIN_SESSION_EXPIRED, so onError leaves the session intact. A future refactor
    // normalizing all non-OK to the sentinel would fail here.
    const msg = adminReturnValidationError(500, false);
    expect(msg).toBe(ADMIN_SESSION_VALIDATION_FAILED);
    expect(msg).not.toBe(ADMIN_SESSION_EXPIRED);
    expect(adminReturnValidationError(503, false)).toBe(ADMIN_SESSION_VALIDATION_FAILED);
  });

  it('returns null for an OK response', () => {
    expect(adminReturnValidationError(200, true)).toBeNull();
  });
});
