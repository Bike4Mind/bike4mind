import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  start: vi.fn(),
  edit: vi.fn(),
  dispatchSigned: vi.fn(),
  assertAi: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions.push(options);
    const handlers: Record<string, Handler> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as Handler & Record<string, (handler: unknown) => unknown>;
    fn.use = () => fn;
    for (const method of ['get', 'post', 'put', 'delete']) {
      fn[method] = (handler: unknown) => ((handlers[method.toUpperCase()] = handler as Handler), fn);
    }
    return fn;
  },
}));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: h.assertAi }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ enforceSubmitRateLimits: vi.fn() }));
vi.mock('@server/skillMarket/classifySkill', () => ({ getOperationsClassifierLlm: vi.fn() }));
vi.mock('@server/utils/dispatchQuest', () => ({ dispatchSigned: h.dispatchSigned }));
vi.mock('@server/skillMarket/templateExample', () => ({
  TEMPLATE_EXAMPLE_DISPATCH_PATH: '/template-example',
  startOwnTemplateExample: h.start,
  editOwnTemplateExample: h.edit,
  templateExampleDispatchIdentity: (payload: { listingId: string }) => ({
    questId: `template-example:${payload.listingId}`,
  }),
}));

import handler from '../example';

const USER = { id: 'author-1', isAdmin: false };

function call(method: string, body?: unknown) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: 'listing-1' }, body: body as object });
  Object.assign(req, { user: USER, logger: { warn: vi.fn() } });
  return { run: () => (handler as unknown as Handler)(req, res), req, res };
}

describe('template example route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses API keys and logged-out callers (jwtOnly)', () => {
    expect(h.baseApiOptions).toEqual([{ auth: 'jwtOnly' }]);
  });

  it('POST starts a run and answers 202 with the running template', async () => {
    h.start.mockResolvedValue({ example: { status: 'running' } });
    const { run, res, req } = call('POST', { prompt: ' Plan the launch ' });
    await run();
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ template: { example: { status: 'running' } } });
    expect(h.assertAi).toHaveBeenCalledWith(USER);
    expect(h.start).toHaveBeenCalledWith(USER, 'listing-1', { prompt: 'Plan the launch' }, expect.any(Object));

    const { dispatch } = h.start.mock.calls[0][3];
    await dispatch({ listingId: 'listing-1' });
    expect(h.dispatchSigned).toHaveBeenCalledWith(
      '/template-example',
      { questId: 'template-example:listing-1' },
      { listingId: 'listing-1' },
      req.logger
    );
  });

  it.each([{ reply: 'hand written' }, { prompt: '' }, { prompt: 'x'.repeat(2001) }])(
    'POST refuses %j before starting anything',
    async body => {
      await expect(call('POST', body).run()).rejects.toThrow();
      expect(h.start).not.toHaveBeenCalled();
    }
  );

  it('PUT passes the switch, trim and sample file through', async () => {
    h.edit.mockResolvedValue({ example: { enabled: false } });
    const { run, res } = call('PUT', { enabled: false, replyTrimmedTo: 120, sampleFabFileId: null });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(h.edit).toHaveBeenCalledWith(
      USER,
      'listing-1',
      { enabled: false, replyTrimmedTo: 120, sampleFabFileId: null },
      expect.objectContaining({ beforeScan: expect.any(Function), getClassifier: expect.any(Function) })
    );
  });

  it.each([{ reply: 'x' }, { artifact: { html: '<p>x</p>' } }, { replyTrimmedTo: 0 }])(
    'PUT refuses %j: the author cannot write the reply or artifact',
    async body => {
      await expect(call('PUT', body).run()).rejects.toThrow();
      expect(h.edit).not.toHaveBeenCalled();
    }
  );
});
