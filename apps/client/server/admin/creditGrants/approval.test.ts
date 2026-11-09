import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

vi.mock('@server/admin/approvals/auditWriter', () => ({ approvalAuditDetails: vi.fn() }));

import { notifyAfterCommit } from './approval';

describe('notifyAfterCommit', () => {
  it('logs a failed push instead of throwing it', async () => {
    const error = vi.fn();
    const req = { logger: { error } } as unknown as Request;
    await expect(notifyAfterCommit(req, () => Promise.reject(new Error('socket down')))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[ADMIN_GRANT_NOTIFY_FAILED]', expect.anything());
  });

  it('runs the push', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyAfterCommit({ logger: { error: vi.fn() } } as unknown as Request, send);
    expect(send).toHaveBeenCalledOnce();
  });
});
