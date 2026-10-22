import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { isMfaAttemptRejectedError, MfaAttemptRejectedError, recordFailedMfaAttempt } from './attempt';

const attemptState = { id: 'user-1', mfa: { failedAttempts: 1 } } as unknown as IUserDocument;
const recordedUser = { id: 'user-1', mfa: { failedAttempts: 2 } } as unknown as IUserDocument;

describe('isMfaAttemptRejectedError', () => {
  it('is true for the error class', () => {
    expect(isMfaAttemptRejectedError(new MfaAttemptRejectedError('x', null))).toBe(true);
  });

  it('is true for a plain Error named MfaAttemptRejectedError (a second module copy)', () => {
    const copy = Object.assign(new Error('x'), { name: 'MfaAttemptRejectedError' });
    expect(isMfaAttemptRejectedError(copy)).toBe(true);
  });

  it('is false for other errors and non-errors', () => {
    expect(isMfaAttemptRejectedError(new Error('x'))).toBe(false);
    expect(isMfaAttemptRejectedError({ name: 'MfaAttemptRejectedError' })).toBe(false);
    expect(isMfaAttemptRejectedError('MfaAttemptRejectedError')).toBe(false);
    expect(isMfaAttemptRejectedError(null)).toBe(false);
  });
});

describe('recordFailedMfaAttempt', () => {
  it('returns the attemptState without touching the repo for a rejection', async () => {
    const repo = { atomicRecordMfaFailedAttempt: vi.fn(async () => recordedUser) };
    const result = await recordFailedMfaAttempt(new MfaAttemptRejectedError('x', attemptState), 'user-1', repo);
    expect(result).toBe(attemptState);
    expect(repo.atomicRecordMfaFailedAttempt).not.toHaveBeenCalled();
  });

  it('counts the attempt now for any other error', async () => {
    const repo = { atomicRecordMfaFailedAttempt: vi.fn(async () => recordedUser) };
    const result = await recordFailedMfaAttempt(new Error('passkey failed'), 'user-1', repo);
    expect(result).toBe(recordedUser);
    expect(repo.atomicRecordMfaFailedAttempt).toHaveBeenCalledWith('user-1');
  });
});
