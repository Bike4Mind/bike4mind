import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { MfaEnrollmentEvents } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ recordForcedEnrollmentStep: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    // Stands in for the next-connect chain; only .post(handler) is used by this route.
    const chain: { use: () => unknown; post: (fn: unknown) => unknown } = { use: () => chain, post: fn => fn };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@server/auth/mfaEnrollmentFunnel', () => ({
  recordForcedEnrollmentStep: mocks.recordForcedEnrollmentStep,
}));

import handler from '../enrollment-abandoned';

type Handler = (req: unknown, res: unknown) => Promise<void>;

async function post(user: unknown, body: unknown = {}) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user });
  await (handler as unknown as Handler)(req, res);
  return { req, res };
}

describe('POST /api/auth/mfa/enrollment-abandoned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordForcedEnrollmentStep.mockResolvedValue(true);
  });

  it('records the abandoned step for the requesting user and answers 204', async () => {
    const user = { id: 'u1', mfaPending: true };
    const { req, res } = await post(user);

    expect(res._getStatusCode()).toBe(204);
    expect(mocks.recordForcedEnrollmentStep).toHaveBeenCalledExactlyOnceWith(req, user, MfaEnrollmentEvents.ABANDONED);
  });

  it('answers 204 whether or not the step was recorded', async () => {
    mocks.recordForcedEnrollmentStep.mockResolvedValue(false);
    expect((await post({ id: 'u1' })).res._getStatusCode()).toBe(204);
  });

  it('accepts no client-chosen fields', async () => {
    await expect(post({ id: 'u1' }, { surface: 'signin' })).rejects.toThrow();
    expect(mocks.recordForcedEnrollmentStep).not.toHaveBeenCalled();
  });

  it('answers 401 without a user', async () => {
    expect((await post(undefined)).res._getStatusCode()).toBe(401);
    expect(mocks.recordForcedEnrollmentStep).not.toHaveBeenCalled();
  });
});
