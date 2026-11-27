// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  isE2EEnabled: vi.fn(() => true),
  isPreviewSleepEnabled: vi.fn(() => true),
  getPreviewSleepStatus: vi.fn(),
  wakePreview: vi.fn(),
  logError: vi.fn(),
  rateLimitMiddleware: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'pr123' }, E2E_CLEANUP_SECRET: { value: 'right-secret' } },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: h.isE2EEnabled }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => h.rateLimitMiddleware }));
vi.mock('@server/previewSleep/previewSleep', () => ({
  isPreviewSleepEnabled: h.isPreviewSleepEnabled,
  getPreviewSleepStatus: h.getPreviewSleepStatus,
  wakePreview: h.wakePreview,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const chain: Record<string, unknown> = { middlewares: [] };
    chain.use = (m: unknown) => ((chain.middlewares as unknown[]).push(m), chain);
    chain.get = (fn: unknown) => ((chain.GET = fn), chain);
    chain.post = (fn: unknown) => ((chain.POST = fn), chain);
    return chain;
  },
}));

import route from '../preview-sleep';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;
const chain = route as unknown as Record<'GET' | 'POST', Handler> & { middlewares: Middleware[] };

// A null secret sends no header at all.
const call = async (method: 'GET' | 'POST', secret: unknown = 'right-secret') => {
  const headers = secret === null ? {} : { 'x-e2e-cleanup-secret': secret };
  const { req, res } = createMocks({ method, headers: headers as Record<string, string> });
  Object.assign(req, { logger: { error: h.logError } });
  for (const middleware of chain.middlewares) {
    let passed = false;
    await middleware(req, res, () => (passed = true));
    if (!passed) return res;
  }
  await chain[method](req, res);
  return res;
};

const STATUS = { asleep: true, waking: false, services: [{ label: 'chat-completion', running: 0, desired: 0 }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.isE2EEnabled.mockReturnValue(true);
  h.isPreviewSleepEnabled.mockReturnValue(true);
  h.getPreviewSleepStatus.mockResolvedValue(STATUS);
  h.wakePreview.mockResolvedValue(undefined);
});

describe('/api/test/preview-sleep', () => {
  it('needs no session and serves only GET and POST', () => {
    expect(h.baseApiOptions.at(-1)).toMatchObject({ auth: false, allowedMethods: ['GET', 'POST'] });
  });

  it.each(['GET', 'POST'] as const)('403s %s when e2e endpoints are off', async method => {
    h.isE2EEnabled.mockReturnValue(false);
    expect((await call(method)).statusCode).toBe(403);
    expect(h.rateLimitMiddleware).not.toHaveBeenCalled();
    expect(h.getPreviewSleepStatus).not.toHaveBeenCalled();
    expect(h.wakePreview).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'] as const)('404s %s off-preview before the rate limiter', async method => {
    h.isPreviewSleepEnabled.mockReturnValue(false);
    expect((await call(method)).statusCode).toBe(404);
    expect(h.rateLimitMiddleware).not.toHaveBeenCalled();
    expect(h.wakePreview).not.toHaveBeenCalled();
  });

  const badSecrets = [
    ['missing', null],
    ['empty', ''],
    ['array-valued', ['right-secret', 'right-secret']],
    ['wrong', 'wrong-secret'],
  ] as const;
  it.each(
    (['GET', 'POST'] as const).flatMap(method => badSecrets.map(([label, secret]) => [method, label, secret] as const))
  )('401s %s with a %s secret after the rate limiter has counted it', async (method, _label, secret) => {
    const res = await call(method, secret);
    expect(res.statusCode).toBe(401);
    expect(h.rateLimitMiddleware).toHaveBeenCalledTimes(1);
    expect(h.getPreviewSleepStatus).not.toHaveBeenCalled();
    expect(h.wakePreview).not.toHaveBeenCalled();
  });

  it('GET returns the sleep status uncached', async () => {
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(res._getJSONData()).toEqual(STATUS);
  });

  it('POST wakes the preview once and answers 202', async () => {
    const res = await call('POST');
    expect(res.statusCode).toBe(202);
    expect(res._getJSONData()).toEqual({ waking: true });
    expect(h.wakePreview).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST'] as const)('hides the AWS error text on a failed %s', async method => {
    const awsError = new Error('AccessDenied: arn:partition:iam::account-id:role/example');
    h.getPreviewSleepStatus.mockRejectedValue(awsError);
    h.wakePreview.mockRejectedValue(awsError);
    const res = await call(method);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res._getJSONData())).not.toContain('arn:');
    expect(h.logError).toHaveBeenCalledTimes(1);
  });
});
