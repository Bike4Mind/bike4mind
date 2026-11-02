import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { ACCOUNT_DELETION_PENDING_FLAG } from '@bike4mind/common';
import { deletionPendingGate } from './deletionPendingGate';

const USER_ID = '665f1c2e8b3a4d0012345678';
const REQUESTED_AT = new Date('2026-03-01T00:00:00.000Z');

function run(url: string, { method = 'GET', deletionRequestedAt = REQUESTED_AT as Date | null } = {}) {
  const req = { url, method, user: { id: USER_ID, deletionRequestedAt }, requestId: 'req-1' } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  deletionPendingGate(req, { status } as unknown as Response, next);
  return { next, status, json };
}

describe('deletionPendingGate', () => {
  it('lets an account that is not pending deletion through', () => {
    const { next, status } = run('/api/quests', { deletionRequestedAt: null });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('refuses a pending account everywhere else with a 403 the client can recognise', () => {
    const { next, status, json } = run('/api/quests?limit=5');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        [ACCOUNT_DELETION_PENDING_FLAG]: true,
        deletionScheduledFor: '2026-03-31T00:00:00.000Z',
        request_id: 'req-1',
      })
    );
  });

  it.each([
    ['POST', '/api/users/me/restore-deletion'],
    ['DELETE', '/api/users/me'],
    ['POST', '/api/logout'],
    ['GET', '/api/identify'],
    ['GET', '/api/settings/fetch?keys=a'],
    ['GET', `/api/users/${USER_ID}`],
  ])('lets a pending account reach %s %s', (method, url) => {
    expect(run(url, { method }).next).toHaveBeenCalledOnce();
  });

  it("refuses a write to the user's own profile and a read of anyone else's", () => {
    expect(run(`/api/users/${USER_ID}`, { method: 'PUT' }).next).not.toHaveBeenCalled();
    expect(run('/api/users/665f1c2e8b3a4d0087654321').next).not.toHaveBeenCalled();
  });
});
