import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      { post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@server/noCardUnlock/runNoCardUnlock', () => ({
  runNoCardUnlock: (...a: unknown[]) => mockRun(...a),
}));

import handler from '../work-email';

const call = (user?: { id: string }) => {
  const { req, res } = createMocks({ method: 'POST' });
  (req as unknown as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res) };
};

describe('POST /api/credits/no-card-unlock/work-email', () => {
  beforeEach(() => mockRun.mockReset());

  it('answers 401 without a user', async () => {
    const { res, promise } = call();
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the work_email_verified unlock for the session user', async () => {
    mockRun.mockResolvedValue({ creditsGranted: 3, currentCredits: 3 });
    const { res, promise } = call({ id: 'u1' });
    await promise;
    expect(mockRun).toHaveBeenCalledWith('work_email_verified', 'u1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ creditsGranted: 3, currentCredits: 3 });
  });

  it('passes a refusal through with status 200', async () => {
    mockRun.mockResolvedValue({ creditsGranted: 0, currentCredits: 0, refusal: 'disabled' });
    const { res, promise } = call({ id: 'u1' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().refusal).toBe('disabled');
  });
});
