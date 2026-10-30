import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockRun, mockStart } = vi.hoisted(() => ({ mockRun: vi.fn(), mockStart: vi.fn() }));

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
vi.mock('@server/noCardUnlock/phoneUnlock', () => ({
  startPhoneUnlock: (...a: unknown[]) => mockStart(...a),
}));

import startHandler from '../phone/start';
import verifyHandler from '../phone/verify';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const call = (handler: unknown, body: unknown, user?: { id: string }) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  (req as unknown as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as Handler)(req, res) };
};

describe('POST /api/credits/no-card-unlock/phone/start', () => {
  beforeEach(() => mockStart.mockReset());

  it('answers 401 without a user', async () => {
    const { res, promise } = call(startHandler, { phoneNumber: '+14155552671' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('rejects a missing number before any send', async () => {
    await expect(call(startHandler, {}, { id: 'u1' }).promise).rejects.toThrow('phoneNumber is required');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('starts the unlock for the session user with the request for rate limiting', async () => {
    mockStart.mockResolvedValue({ sent: false, refusal: 'phone_line_type' });
    const { req, res, promise } = call(startHandler, { phoneNumber: '+14155552671' }, { id: 'u1' });
    await promise;
    expect(mockStart).toHaveBeenCalledWith('u1', '+14155552671', req);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ sent: false, refusal: 'phone_line_type' });
  });
});

describe('POST /api/credits/no-card-unlock/phone/verify', () => {
  beforeEach(() => mockRun.mockReset());

  it('answers 401 without a user', async () => {
    const { res, promise } = call(verifyHandler, { code: '123456' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it.each([{}, { code: 'abcdef' }, { code: '12' }, { code: 123456 }])('rejects body %j', async body => {
    await expect(call(verifyHandler, body, { id: 'u1' }).promise).rejects.toThrow('code must be');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the phone_verified unlock with the typed code', async () => {
    mockRun.mockResolvedValue({ creditsGranted: 3, currentCredits: 3 });
    const { res, promise } = call(verifyHandler, { code: '123456' }, { id: 'u1' });
    await promise;
    expect(mockRun).toHaveBeenCalledWith('phone_verified', 'u1', { phoneCode: '123456' });
    expect(res._getJSONData()).toEqual({ creditsGranted: 3, currentCredits: 3 });
  });
});
