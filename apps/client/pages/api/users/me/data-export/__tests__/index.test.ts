import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  post: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  uses: [] as unknown[],
  send: vi.fn(),
  logAuthAudit: vi.fn(),
  tryIncrement: vi.fn(),
  decrement: vi.fn(),
  stepUpGate: vi.fn(() => 'stepUpGate'),
  csrfProtection: vi.fn(() => 'csrfProtection'),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    const chain = {
      use: (middleware: unknown) => {
        h.uses.push(middleware);
        return chain;
      },
      post: (fn: typeof h.post) => {
        h.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: h.csrfProtection }));
vi.mock('@server/auth/stepUp', () => ({ stepUpGate: h.stepUpGate }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement, decrementCounter: h.decrement },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.send }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (name: string) => `http://queue/${name}`,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));

import { ForbiddenError } from '@bike4mind/common';
import { TooManyRequestsError } from '@bike4mind/utils';
import '../index';

const RATE_KEY = 'rate-limit:665f1c2e8b3a4d0012345678:account-data-export';
const USER_ID = '665f1c2e8b3a4d0012345678';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function run(user: Record<string, unknown> = { id: USER_ID }) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  await h.post!(req, res);
  return res;
}

beforeEach(() => {
  h.send.mockReset().mockResolvedValue(undefined);
  h.logAuthAudit.mockReset();
  h.tryIncrement.mockReset().mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 3600000) });
  h.decrement.mockReset().mockResolvedValue(0);
});

describe('POST /api/users/me/data-export', () => {
  it('is browser-session only and step-up gated', () => {
    expect(h.baseApiOptions).toEqual({ auth: 'jwtOnly' });
    expect(h.uses).toEqual(['csrfProtection', 'stepUpGate']);
  });

  it("queues an export of the caller's own data and audits it", async () => {
    const res = await run();

    expect(res._getStatusCode()).toBe(202);
    const { exportJobId } = res._getJSONData();
    expect(exportJobId).toMatch(UUID);
    expect(h.send).toHaveBeenCalledWith('http://queue/accountDataExportQueue', { exportJobId, userId: USER_ID });
    expect(h.logAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER_ID,
        event: 'account_data_export_requested',
        metadata: { exportJobId },
      })
    );
  });

  it('refuses an impersonating admin', async () => {
    await expect(run({ id: USER_ID, impersonatedBy: '665f1c2e8b3a4d0087654321' })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it('answers 500 without auditing when the job cannot be queued', async () => {
    h.send.mockRejectedValueOnce(new Error('broker unavailable'));
    const res = await run();

    expect(res._getStatusCode()).toBe(500);
    expect(h.logAuthAudit).not.toHaveBeenCalled();
    expect(h.decrement).toHaveBeenCalledWith(RATE_KEY);
  });

  it('keeps the quota slot after a successful enqueue', async () => {
    await run();

    expect(h.tryIncrement).toHaveBeenCalledWith(RATE_KEY, 1, 3600000);
    expect(h.decrement).not.toHaveBeenCalled();
  });

  it('answers 429 without queueing when the hourly quota is spent', async () => {
    h.tryIncrement.mockResolvedValue({ success: false, count: 1, expiresAt: new Date(Date.now() + 120000) });

    await expect(run()).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.decrement).not.toHaveBeenCalled();
  });

  it('still answers 500 when releasing the quota slot fails', async () => {
    h.send.mockRejectedValueOnce(new Error('broker unavailable'));
    h.decrement.mockRejectedValueOnce(new Error('db down'));

    const res = await run();
    expect(res._getStatusCode()).toBe(500);
  });
});
