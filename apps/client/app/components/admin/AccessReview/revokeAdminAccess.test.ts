import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { revokeAdmins, type BulkRevokeOutcome } from './revokeAdminAccess';

const mocks = vi.hoisted(() => ({ put: vi.fn(), post: vi.fn(), stepUpCancelled: new Set<unknown>() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: mocks.put, post: mocks.post } }));
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => mocks.stepUpCancelled.has(error),
}));

const FULL = 'a'.repeat(24);
const DELEGATE = 'b'.repeat(24);
const THIRD = 'c'.repeat(24);

const admin = (overrides: Partial<AccessReviewRow>): AccessReviewRow => ({
  userId: FULL,
  email: null,
  username: null,
  fullAdmin: true,
  permissions: [],
  directPermissions: [],
  adminRoleIds: [],
  roles: [],
  permissionSources: [],
  lastAdminActionAt: null,
  lastSignInAt: null,
  mfaEnabled: false,
  grantedBy: null,
  grantedAt: null,
  dormant: true,
  noMfa: true,
  decision: null,
  ...overrides,
});

const httpError = (status: number, message: string) =>
  new AxiosError('failed', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    data: { error: message },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const full = admin({ userId: FULL, directPermissions: ['users:moderate'] });
const delegate = admin({ userId: DELEGATE, fullAdmin: false, adminRoleIds: ['support'] });
const third = admin({ userId: THIRD });

const decisionCall = (userId: string) => [
  '/api/admin/access-review/decisions',
  { userId, decision: 'revoked', dormantDays: 90 },
];

describe('revokeAdmins', () => {
  beforeEach(() => {
    mocks.put.mockReset().mockResolvedValue({ data: {} });
    mocks.post.mockReset().mockResolvedValue({ data: {} });
    mocks.stepUpCancelled.clear();
  });

  it('removes each admin through the audited per-admin routes, then records one decision per admin', async () => {
    const outcomes = await revokeAdmins([full, delegate], 'left the team', 90);
    expect(outcomes).toEqual([
      { userId: FULL, state: 'revoked' },
      { userId: DELEGATE, state: 'revoked' },
    ]);
    expect(mocks.put.mock.calls).toEqual([
      [`/api/admin/users/${FULL}/role`, { isAdmin: false, reason: 'left the team' }],
      [
        `/api/admin/users/${FULL}/permissions`,
        {
          before: ['users:moderate'],
          adminPermissions: [],
          beforeAdminRoleIds: [],
          adminRoleIds: [],
          reason: 'left the team',
        },
      ],
      [
        `/api/admin/users/${DELEGATE}/permissions`,
        {
          before: [],
          adminPermissions: [],
          beforeAdminRoleIds: ['support'],
          adminRoleIds: [],
          reason: 'left the team',
        },
      ],
    ]);
    expect(mocks.post.mock.calls).toEqual([decisionCall(FULL), decisionCall(DELEGATE)]);
  });

  it('records nothing for an admin whose removal was refused, and carries on with the rest', async () => {
    mocks.put.mockRejectedValueOnce(httpError(409, 'Cannot remove the last super admin'));
    const outcomes = await revokeAdmins([full, delegate], 'reason', 90);
    expect(outcomes).toEqual([
      { userId: FULL, state: 'failed', message: 'Cannot remove the last super admin' },
      { userId: DELEGATE, state: 'revoked' },
    ]);
    expect(mocks.post.mock.calls).toEqual([decisionCall(DELEGATE)]);
  });

  it('still tries to record after an uncertain removal, which the server refuses if access remains', async () => {
    mocks.put.mockRejectedValueOnce(new Error('network'));
    const outcomes = await revokeAdmins([third], 'reason', 90);
    expect(outcomes).toEqual([{ userId: THIRD, state: 'revoked' }]);
    expect(mocks.post.mock.calls).toEqual([decisionCall(THIRD)]);
  });

  it('marks an admin unrecorded when the decision fails, and a retry records it without removing access again', async () => {
    mocks.post.mockRejectedValueOnce(httpError(500, 'Database unavailable'));
    const first = await revokeAdmins([third], 'reason', 90);
    expect(first).toEqual([{ userId: THIRD, state: 'unrecorded', message: 'Database unavailable' }]);
    mocks.put.mockClear();
    const retried = await revokeAdmins([third], 'reason', 90, new Map(first.map(o => [o.userId, o])));
    expect(retried).toEqual([{ userId: THIRD, state: 'revoked' }]);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('stops at a cancelled step-up, leaves the rest unstarted, and a retry keeps finished admins', async () => {
    const cancelled = new Error('step-up cancelled');
    mocks.stepUpCancelled.add(cancelled);
    mocks.put.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(cancelled);
    const first = await revokeAdmins([full, delegate, third], 'reason', 90);
    expect(first.map(outcome => outcome.state)).toEqual(['revoked', 'skipped', 'skipped']);
    expect(mocks.post.mock.calls).toEqual([decisionCall(FULL)]);

    mocks.put.mockClear();
    mocks.post.mockClear();
    const previous = new Map<string, BulkRevokeOutcome>(first.map(o => [o.userId, o]));
    const retried = await revokeAdmins([full, delegate, third], 'reason', 90, previous);
    expect(retried.map(outcome => outcome.state)).toEqual(['revoked', 'revoked', 'revoked']);
    expect(mocks.post.mock.calls).toEqual([decisionCall(DELEGATE), decisionCall(THIRD)]);
  });
});
