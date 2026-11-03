import { describe, it, expect } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';
import { accountDeletionPendingFrom } from './accountDeletionInterceptor';

const errorWith = (status: number, data: unknown) =>
  new AxiosError('failed', undefined, undefined, undefined, { status, data } as AxiosResponse);

describe('accountDeletionPendingFrom', () => {
  it('returns the scheduled date for a deletion-pending 403', () => {
    const scheduledFor = '2026-12-01T00:00:00.000Z';
    expect(accountDeletionPendingFrom(errorWith(403, { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor }))).toBe(
      scheduledFor
    );
  });

  it('returns null when the code is present but the date is missing or empty', () => {
    expect(accountDeletionPendingFrom(errorWith(403, { code: ACCOUNT_DELETION_PENDING_CODE }))).toBeNull();
    expect(
      accountDeletionPendingFrom(errorWith(403, { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor: '' }))
    ).toBeNull();
  });

  it('returns null when the date is not a string', () => {
    expect(
      accountDeletionPendingFrom(errorWith(403, { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor: 1790000000000 }))
    ).toBeNull();
    expect(
      accountDeletionPendingFrom(errorWith(403, { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor: { at: 'x' } }))
    ).toBeNull();
  });

  it('returns null for a 403 with another code and for a non-403', () => {
    expect(accountDeletionPendingFrom(errorWith(403, { code: 'OTHER', scheduledFor: 'x' }))).toBeNull();
    expect(
      accountDeletionPendingFrom(errorWith(401, { code: ACCOUNT_DELETION_PENDING_CODE, scheduledFor: 'x' }))
    ).toBeNull();
    expect(accountDeletionPendingFrom(new Error('boom'))).toBeNull();
  });
});
