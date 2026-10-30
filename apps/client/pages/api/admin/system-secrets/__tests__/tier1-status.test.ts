// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({ evaluateTier1Secrets: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: (req: unknown, res: unknown) => unknown) => fn,
  }),
}));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'test' } }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@bike4mind/infra', () => ({ evaluateTier1Secrets: h.evaluateTier1Secrets, PRODUCTION_STAGES: [] }));

import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import handler from '../tier1-status';

describe('non-admin access', () => {
  it('GET rejects with ForbiddenError without logging an error', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    (req as Record<string, unknown>).user = { id: 'user-1', isAdmin: false };

    await expect(
      (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(Logger.error).not.toHaveBeenCalled();
    expect(h.evaluateTier1Secrets).not.toHaveBeenCalled();
  });
});
