import { describe, it, expect } from 'vitest';
import { ACCOUNT_DELETION_PENDING_CODE, ForbiddenError } from '@bike4mind/common';
import { assertNoPendingDeletion, isBlockedByPendingDeletion } from './deletionPendingGate';

const scheduledFor = new Date('2026-11-17T00:00:00.000Z');
const frozen = { id: 'u1', deletion: { scheduledFor } };

describe('isBlockedByPendingDeletion', () => {
  it('ignores users with no pending deletion', () => {
    expect(isBlockedByPendingDeletion({ id: 'u1' }, '/api/quests', 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion({ id: 'u1', deletion: null }, '/api/quests', 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion(undefined, '/api/quests', 'GET')).toBe(false);
  });

  it('matches the allowlist by exact path and method, ignoring the query string', () => {
    expect(isBlockedByPendingDeletion(frozen, '/api/account/deletion?x=1', 'DELETE')).toBe(false);
    expect(isBlockedByPendingDeletion(frozen, '/api/account/deletion', 'POST')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, '/api/identify', 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion(frozen, '/api/identifyx', 'GET')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, '/api/users/u1', 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion(frozen, '/api/users/u1', 'PUT')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, '/api/users/u2', 'GET')).toBe(true);
  });

  it('lets a pending account download an export it requested, but not start a new one', () => {
    const download = '/api/users/me/data-export/7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
    expect(isBlockedByPendingDeletion(frozen, download, 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion(frozen, `${download}?x=1`, 'GET')).toBe(false);
    expect(isBlockedByPendingDeletion(frozen, download, 'DELETE')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, `${download}/extra`, 'GET')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, '/api/users/me/data-export', 'POST')).toBe(true);
    expect(isBlockedByPendingDeletion(frozen, '/api/users/me/data-export', 'GET')).toBe(true);
  });
});

describe('assertNoPendingDeletion', () => {
  it('throws a 403 carrying the code and purge date', () => {
    let thrown: unknown;
    try {
      assertNoPendingDeletion(frozen);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect((thrown as ForbiddenError).additionalInfo).toEqual({
      code: ACCOUNT_DELETION_PENDING_CODE,
      scheduledFor: scheduledFor.toISOString(),
    });
  });

  it('passes an account with no pending deletion', () => {
    expect(() => assertNoPendingDeletion({ deletion: null })).not.toThrow();
  });
});
