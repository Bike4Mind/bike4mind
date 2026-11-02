import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ requestAccountDeletion: vi.fn(), logAuthAudit: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ delete: (fn: (req: unknown, res: unknown) => unknown) => fn }),
}));
vi.mock('@server/accountDeletion/requestAccountDeletion', () => ({
  requestAccountDeletion: mocks.requestAccountDeletion,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: mocks.logAuthAudit }));

import { ForbiddenError } from '@bike4mind/common';
import handler from '../index';

const USER_ID = '665f1c2e8b3a4d0012345678';
const REQUESTED_AT = new Date('2026-03-01T00:00:00.000Z');
const SCHEDULED_FOR = new Date('2026-03-31T00:00:00.000Z');

async function run(user: Record<string, unknown> = { id: USER_ID }) {
  const { req, res } = createMocks({ method: 'DELETE' });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestAccountDeletion.mockResolvedValue({
    deletionRequestedAt: REQUESTED_AT,
    deletionScheduledFor: SCHEDULED_FOR,
    newlyRequested: true,
    canceledSubscriptions: ['sub_1'],
  });
});

describe('DELETE /api/users/me', () => {
  it('schedules the deletion of the caller and audits the request', async () => {
    const res = await run();

    expect(mocks.requestAccountDeletion).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ logger: expect.any(Object) })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      deletionRequestedAt: REQUESTED_AT.toISOString(),
      deletionScheduledFor: SCHEDULED_FOR.toISOString(),
    });
    expect(mocks.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: USER_ID, event: 'account_deletion_requested' })
    );
  });

  it('does not audit a repeated request a second time', async () => {
    mocks.requestAccountDeletion.mockResolvedValue({
      deletionRequestedAt: REQUESTED_AT,
      deletionScheduledFor: SCHEDULED_FOR,
      newlyRequested: false,
      canceledSubscriptions: [],
    });

    const res = await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.logAuthAudit).not.toHaveBeenCalled();
  });

  it('refuses an impersonating admin', async () => {
    await expect(run({ id: USER_ID, impersonatedBy: '665f1c2e8b3a4d0087654321' })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mocks.requestAccountDeletion).not.toHaveBeenCalled();
  });
});
