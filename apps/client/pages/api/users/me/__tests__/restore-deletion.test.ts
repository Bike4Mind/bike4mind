import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({ restoreAccountDeletion: vi.fn(), logAuthAudit: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: (req: unknown, res: unknown) => unknown) => fn }),
}));
vi.mock('@server/accountDeletion/restoreAccountDeletion', () => ({
  restoreAccountDeletion: mocks.restoreAccountDeletion,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: mocks.logAuthAudit }));

import { ForbiddenError } from '@bike4mind/common';
import handler from '../restore-deletion';

const USER_ID = '665f1c2e8b3a4d0012345678';

async function run(user: Record<string, unknown> = { id: USER_ID }) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/users/me/restore-deletion', () => {
  it('restores a pending account within its grace period and audits it', async () => {
    mocks.restoreAccountDeletion.mockResolvedValue({ restored: true });

    const res = await run();

    expect(res._getJSONData()).toEqual({ restored: true });
    expect(mocks.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: USER_ID, event: 'account_deletion_restored' })
    );
  });

  it('reports a repeat as a no-op without auditing it', async () => {
    mocks.restoreAccountDeletion.mockResolvedValue({ restored: false });

    const res = await run();

    expect(res._getJSONData()).toEqual({ restored: false });
    expect(mocks.logAuthAudit).not.toHaveBeenCalled();
  });

  it('refuses an impersonating admin', async () => {
    await expect(run({ id: USER_ID, impersonatedBy: '665f1c2e8b3a4d0087654321' })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mocks.restoreAccountDeletion).not.toHaveBeenCalled();
  });
});
