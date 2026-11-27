// @vitest-environment node
/**
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is not, so the contract's
 * request validation runs for real. JWT-only enforcement lives in baseApi; the options it receives are asserted.
 */
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userRepository, baseApiOptions } = vi.hoisted(() => ({
  userRepository: { getBusyBlocks: vi.fn(), setBusyBlocks: vi.fn() },
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

const { default: handler } = await import('../busy-blocks');

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
const START = '2026-11-20T15:00:00.000Z';
const END = '2026-11-20T16:00:00.000Z';

describe('/api/v1/briefs/busy-blocks through the contract wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds both routes JWT-only, so an API key or no token never reaches the handler', () => {
    expect(baseApiOptions).toHaveLength(2);
    for (const options of baseApiOptions) expect(options).toMatchObject({ auth: 'jwtOnly' });
  });

  it.each([
    ['a block ending at its start', { enabled: true, blocks: [{ start: START, end: START }] }],
    ['a block longer than 12 hours', { enabled: true, blocks: [{ start: START, end: '2026-11-21T03:00:01.000Z' }] }],
    ['a non-array', { enabled: true, blocks: { start: START, end: END } }],
    ['a missing enabled flag', { blocks: [] }],
  ])('rejects %s before anything is written', async (_label, body) => {
    await expect(put(body)).rejects.toMatchObject({ name: expect.stringMatching(/ZodError|BadRequestError/) });
    expect(userRepository.setBusyBlocks).not.toHaveBeenCalled();
  });

  it('writes only the caller with Date bounds and no event details, and echoes the stored state', async () => {
    userRepository.setBusyBlocks.mockResolvedValue({
      enabled: true,
      blocks: [{ start: new Date(START), end: new Date(END) }],
      nextBlockBriefAt: new Date(END),
    });
    const res = await put({ enabled: true, blocks: [{ start: START, end: END, title: 'Board meeting' }] });
    expect(res._getStatusCode()).toBe(200);
    expect(userRepository.setBusyBlocks).toHaveBeenCalledWith(
      'user-1',
      { enabled: true, blocks: [{ start: new Date(START), end: new Date(END) }] },
      expect.any(Date)
    );
    expect(res._getJSONData()).toEqual({ enabled: true, blocks: [{ start: START, end: END }], nextBlockBriefAt: END });
  });

  it('passes a disable through and reports nothing pending', async () => {
    userRepository.setBusyBlocks.mockResolvedValue({ enabled: false, blocks: [], nextBlockBriefAt: null });
    const res = await put({ enabled: false, blocks: [] });
    expect(userRepository.setBusyBlocks).toHaveBeenCalledWith(
      'user-1',
      { enabled: false, blocks: [] },
      expect.any(Date)
    );
    expect(res._getJSONData()).toEqual({ enabled: false, blocks: [], nextBlockBriefAt: null });
  });

  it('GET serializes the stored state for the caller', async () => {
    userRepository.getBusyBlocks.mockResolvedValue({
      enabled: true,
      blocks: [{ start: new Date(START), end: new Date(END) }],
      nextBlockBriefAt: new Date(END),
    });
    const res = await get();
    expect(userRepository.getBusyBlocks).toHaveBeenCalledWith('user-1');
    expect(res._getJSONData()).toEqual({ enabled: true, blocks: [{ start: START, end: END }], nextBlockBriefAt: END });
  });
});
