// @vitest-environment node
/**
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is not, so the contract's
 * request validation runs for real. JWT-only enforcement lives in baseApi; the options it receives are asserted.
 */
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userRepository, baseApiOptions } = vi.hoisted(() => ({
  userRepository: { getInterruptionFeedback: vi.fn(), setInterruptionFeedback: vi.fn() },
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: vi.fn(),
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: (err?: unknown) => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          let failure: unknown;
          await handler(req, res, err => {
            advanced = true;
            failure = err;
          });
          if (failure) throw failure;
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    chain.put = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({ userRepository }));

const { default: handler } = await import('../interruptions');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const put = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'PUT', body: body as Record<string, unknown> });
  Object.assign(req, { user: { id: 'user-1' }, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};
const get = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'user-1' }, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('/api/v1/assistant/interruptions through the contract wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds both routes JWT-only, so an API key or no token never reaches the handler', () => {
    expect(baseApiOptions).toHaveLength(2);
    for (const options of baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });

  it('GET returns an empty feedback object when nothing is stored', async () => {
    userRepository.getInterruptionFeedback.mockResolvedValue({});
    const res = await get();
    expect(userRepository.getInterruptionFeedback).toHaveBeenCalledWith('user-1');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ feedback: {} });
  });

  it('PUT writes only the caller and echoes the stored state', async () => {
    userRepository.setInterruptionFeedback.mockResolvedValue({ agent_completed: true, agent_failed: false });
    const res = await put({ agent_completed: true });
    expect(res._getStatusCode()).toBe(200);
    expect(userRepository.setInterruptionFeedback).toHaveBeenCalledTimes(1);
    expect(userRepository.setInterruptionFeedback).toHaveBeenCalledWith('user-1', { agent_completed: true });
    expect(res._getJSONData()).toEqual({ feedback: { agent_completed: true, agent_failed: false } });
  });

  it('PUT with an empty body is a no-op patch', async () => {
    userRepository.setInterruptionFeedback.mockResolvedValue({ agent_failed: true });
    const res = await put({});
    expect(res._getStatusCode()).toBe(200);
    expect(userRepository.setInterruptionFeedback).toHaveBeenCalledWith('user-1', {});
    expect(res._getJSONData()).toEqual({ feedback: { agent_failed: true } });
  });

  it.each([
    ['a category that is never held', { approval_needed: true }],
    ['a user id in the body', { agent_completed: true, userId: 'user-2' }],
    ['a non-boolean value', { agent_completed: 'yes' }],
    ['an array body', [{ agent_completed: true }]],
  ])('rejects %s before anything is written', async (_label, body) => {
    await expect(put(body)).rejects.toMatchObject({ name: expect.stringMatching(/ZodError|BadRequestError/) });
    expect(userRepository.setInterruptionFeedback).not.toHaveBeenCalled();
  });
});
