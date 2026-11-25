// @vitest-environment node
/**
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is not, so the contract's
 * request validation runs for real. JWT-only enforcement lives in baseApi; the options it receives are asserted.
 */
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startFollowUpComposition, serializeBrief, baseApiOptions } = vi.hoisted(() => ({
  startFollowUpComposition: vi.fn(),
  serializeBrief: vi.fn(),
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
    chain.post = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/briefs/startBriefComposition', () => ({ startFollowUpComposition }));
vi.mock('@server/briefs/serializeBrief', () => ({ serializeBrief }));

const { default: handler } = await import('../follow-ups');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const post = async (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  Object.assign(req, { user: { id: 'user-1' }, logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

describe('POST /api/v1/briefs/follow-ups through the contract wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startFollowUpComposition.mockResolvedValue({ _id: 'b1' });
    serializeBrief.mockResolvedValue({ id: 'b1', status: 'composing' });
  });

  it('builds the route JWT-only', () => {
    expect(baseApiOptions).toHaveLength(1);
    expect(baseApiOptions[0]).toMatchObject({ auth: 'jwtOnly' });
  });

  it('starts a follow-up brief for the caller and answers 202 with it composing', async () => {
    const res = await post({ transcript: 'Email Sam the notes', timeZone: 'America/New_York' });
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ id: 'b1', status: 'composing' });
    expect(startFollowUpComposition).toHaveBeenCalledWith('user-1', {
      transcript: 'Email Sam the notes',
      timeZone: 'America/New_York',
    });
  });

  it('passes on the validated body, not the raw one', async () => {
    await post({ transcript: 'Email Sam the notes', origin: 'injected' });
    expect(startFollowUpComposition).toHaveBeenCalledWith('user-1', { transcript: 'Email Sam the notes' });
  });

  it.each([
    ['an empty transcript', { transcript: '' }],
    ['a blank transcript', { transcript: '  \n ' }],
    ['an oversize transcript', { transcript: 'a'.repeat(6001) }],
    ['an unknown zone', { transcript: 'memo', timeZone: 'Mars/Olympus' }],
    ['no transcript', {}],
  ])('rejects %s without starting anything', async (_label, body) => {
    // The contract wrapper throws the validation error for baseApi's error handler (stubbed here) to answer.
    await expect(post(body)).rejects.toMatchObject({ name: 'ZodError' });
    expect(startFollowUpComposition).not.toHaveBeenCalled();
  });
});
