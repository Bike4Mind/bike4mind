// @vitest-environment node
/**
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is not, so the contract's
 * request validation runs for real. JWT-only enforcement lives in baseApi; the options it receives are asserted.
 */
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userRepository, baseApiOptions } = vi.hoisted(() => ({
  userRepository: { getBriefSchedule: vi.fn(), setBriefSchedule: vi.fn() },
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

const { default: handler } = await import('../schedule');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const put = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'PUT', body: body as Record<string, unknown> });
  Object.assign(req, { user: { id: 'user-1' }, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};
const schedule = { enabled: true, timeOfDay: '08:00', days: [1, 2, 3, 4, 5], timeZone: 'America/New_York' };

describe('/api/v1/briefs/schedule through the contract wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds both routes JWT-only, so an API key or no token never reaches the handler', () => {
    expect(baseApiOptions).toHaveLength(2);
    for (const options of baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });

  it.each([
    ['an unknown time zone', { ...schedule, timeZone: 'Mars/Olympus' }],
    ['a bare UTC offset', { ...schedule, timeZone: '+05:30' }],
    ['an out-of-range time', { ...schedule, timeOfDay: '24:00' }],
    ['no days', { ...schedule, days: [] }],
    ['a repeated day', { ...schedule, days: [1, 1] }],
    ['a weekday past Saturday', { ...schedule, days: [7] }],
  ])('rejects %s before anything is written', async (_label, body) => {
    await expect(put(body)).rejects.toMatchObject({ name: expect.stringMatching(/ZodError|BadRequestError/) });
    expect(userRepository.setBriefSchedule).not.toHaveBeenCalled();
  });
});
