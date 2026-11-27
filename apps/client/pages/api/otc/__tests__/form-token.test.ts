import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { evaluateSignupSignals } from '@server/utils/signupBotChecks';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = { use: () => chain, get: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { JWT_SECRET: 'test-secret' },
  isE2EEnabled: () => false,
}));

import handler from '@pages/api/otc/form-token';

describe('GET /api/otc/form-token', () => {
  it('returns a token the signal evaluator accepts as valid', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await (handler as any)(req, res);
    expect(res._getStatusCode()).toBe(200);
    const { formToken } = res._getJSONData();
    expect(evaluateSignupSignals({ formToken, nowMs: Date.now() + 5000, minSubmitMs: 1500 })).toEqual([]);
  });
});
