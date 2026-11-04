import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';
import {
  accountDeletionPendingFrom,
  registerAccountDeletionRequestGuard,
  setDeletionGuardUser,
} from './accountDeletionInterceptor';

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

describe('registerAccountDeletionRequestGuard', () => {
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
    data: {},
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }));
  const client = axios.create({ adapter });
  let eject: () => void;

  const pending = { id: 'u1', deletion: { scheduledFor: new Date('2026-12-01T00:00:00.000Z') } };

  beforeEach(() => {
    adapter.mockClear();
    eject = registerAccountDeletionRequestGuard(client);
  });

  afterEach(() => {
    eject();
    setDeletionGuardUser(null);
  });

  it('cancels app requests before they are sent while the deletion is pending', async () => {
    setDeletionGuardUser(pending);

    for (const send of [
      () => client.get('/api/sessions'),
      () => client.get('/api/settings/serverConfig'),
      () => client.post('/api/account/deletion'),
      () => client.get('/api/users/someone-else'),
    ]) {
      const error = await send().catch((e: unknown) => e);
      expect(axios.isCancel(error)).toBe(true);
    }
    expect(adapter).not.toHaveBeenCalled();
  });

  it('lets the cancel screen, sign-out and session refresh through while the deletion is pending', async () => {
    setDeletionGuardUser(pending);

    await client.get('/api/account/deletion');
    await client.delete('/api/account/deletion');
    await client.get('/api/identify?fresh=1');
    await client.get('/api/logout');
    await client.get('/api/users/u1');
    await client.post('/api/auth/refreshToken');

    expect(adapter).toHaveBeenCalledTimes(6);
  });

  it('sends every request for a user with no pending deletion, and when signed out', async () => {
    setDeletionGuardUser({ id: 'u1', deletion: null });
    await client.get('/api/sessions');
    setDeletionGuardUser(null);
    await client.get('/api/settings/logo');

    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
