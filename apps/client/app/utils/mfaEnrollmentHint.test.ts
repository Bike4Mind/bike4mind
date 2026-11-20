import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MFA_ENROLLMENT_HINT_KEY, readMfaEnrolledHint, writeMfaEnrolledHint } from './mfaEnrollmentHint';

describe('mfaEnrollmentHint', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads back an enrolled hint for the same user', () => {
    writeMfaEnrolledHint('u1', true);
    expect(readMfaEnrolledHint('u1')).toBe(true);
  });

  it('never vouches for a different user on the same browser', () => {
    writeMfaEnrolledHint('u1', true);
    expect(readMfaEnrolledHint('u2')).toBe(false);
  });

  it('reads false once the latest status said not enrolled', () => {
    writeMfaEnrolledHint('u1', true);
    writeMfaEnrolledHint('u1', false);
    expect(readMfaEnrolledHint('u1')).toBe(false);
  });

  it('reads false with no user, no hint, or a hint of the wrong shape', () => {
    expect(readMfaEnrolledHint(undefined)).toBe(false);
    expect(readMfaEnrolledHint('u1')).toBe(false);

    for (const bad of ['not json', '{"userId":"u1","enrolled":"true"}', '{"enrolled":true}', 'null', '[]']) {
      localStorage.setItem(MFA_ENROLLMENT_HINT_KEY, bad);
      expect(readMfaEnrolledHint('u1')).toBe(false);
    }
  });

  it('reads false and writes nothing, without throwing, when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => writeMfaEnrolledHint('u1', true)).not.toThrow();
    expect(readMfaEnrolledHint('u1')).toBe(false);
  });
});
