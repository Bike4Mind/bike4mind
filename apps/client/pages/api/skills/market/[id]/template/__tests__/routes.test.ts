import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  baseApiOptions: [] as unknown[],
  rateLimitOpts: [] as Array<{ bucket?: string }>,
  rateLimitResolved: [] as Array<(req: unknown) => Promise<number>>,
  enforceSubmit: vi.fn(),
  getLlm: vi.fn(),
  getOwnTemplateView: vi.fn(),
  saveOwnTemplate: vi.fn(),
  deleteOwnTemplate: vi.fn(),
  publishOwnTemplate: vi.fn(),
  unpublishOwnTemplate: vi.fn(),
  approvedSnapshotForDraft: vi.fn(),
  rateTier: vi.fn(async () => 30),
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
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (opts: { bucket?: string; limit: (req: unknown) => Promise<number> }) => {
    h.rateLimitOpts.push(opts);
    h.rateLimitResolved.push(opts.limit);
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: h.rateTier }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ enforceSubmitRateLimits: h.enforceSubmit }));
vi.mock('@server/skillMarket/classifySkill', () => ({ getOperationsClassifierLlm: h.getLlm }));
vi.mock('@server/skillMarket/templateImage', () => ({ getOwnTemplateView: h.getOwnTemplateView }));
vi.mock('@server/skillMarket/template', () => ({
  saveOwnTemplate: h.saveOwnTemplate,
  deleteOwnTemplate: h.deleteOwnTemplate,
  publishOwnTemplate: h.publishOwnTemplate,
  unpublishOwnTemplate: h.unpublishOwnTemplate,
  approvedSnapshotForDraft: h.approvedSnapshotForDraft,
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import templateHandler from '../index';
import draftHandler from '../draft';
import publishHandler from '../publish';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';

const USER = { id: 'author-1', isAdmin: false };
const snapshot = { name: 'summarize', description: 'Summarizes', body: 'Summarize it.' };

function call(handler: unknown, method: string, body?: unknown) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: 'listing-1' }, body: body as object });
  Object.assign(req, { user: USER, logger: { warn: vi.fn() } });
  return { run: () => (handler as Handler)(req, res), req, res };
}

describe('template routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.approvedSnapshotForDraft.mockResolvedValue({ snapshot, versionId: 'version-1' });
  });

  it('every route refuses API keys and logged-out callers (jwtOnly)', () => {
    expect(h.baseApiOptions).toHaveLength(3);
    for (const options of h.baseApiOptions) expect(options).toEqual({ auth: 'jwtOnly' });
  });

  it('only the draft route has a rate limiter of its own, in its own bucket', () => {
    expect(h.rateLimitOpts.map(o => o.bucket)).toEqual(['skill-market-template-draft']);
  });

  it('the draft limit is 20 an hour, unlimited for super-admins and blocked for a blocked tier', async () => {
    const limit = h.rateLimitResolved[0];
    expect(await limit({ user: USER })).toBe(20);
    expect(await limit({ user: { ...USER, isAdmin: true } })).toBe(Infinity);
    h.rateTier.mockResolvedValueOnce(0);
    expect(await limit({ user: USER })).toBe(0);
  });

  it.each([
    ['GET', templateHandler, h.getOwnTemplateView],
    ['PUT', templateHandler, h.saveOwnTemplate],
    ['DELETE', templateHandler, h.deleteOwnTemplate],
    ['POST', publishHandler, h.publishOwnTemplate],
    ['DELETE', publishHandler, h.unpublishOwnTemplate],
    ['POST', draftHandler, h.approvedSnapshotForDraft],
  ])('%s passes the caller and listing id to the author check', async (method, handler, fn) => {
    fn.mockRejectedValueOnce(new ForbiddenError('not yours'));
    await expect(call(handler, method, {}).run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(fn.mock.calls[0].slice(0, 2)).toEqual([USER, 'listing-1']);
  });

  it('GET answers with the editor view', async () => {
    const view = { template: null, suggestedSlug: 'summarize', eligibility: { eligible: true } };
    h.getOwnTemplateView.mockResolvedValue(view);
    const { run, res } = call(templateHandler, 'GET');
    await run();
    expect(res._getJSONData()).toEqual(view);
  });

  it('PUT rejects fields the author may not write', async () => {
    await expect(call(templateHandler, 'PUT', { status: 'published' }).run()).rejects.toThrow();
    await expect(call(templateHandler, 'PUT', { freeRunEnabled: true }).run()).rejects.toThrow();
    expect(h.saveOwnTemplate).not.toHaveBeenCalled();
  });

  it('PUT rejects a fourth input', async () => {
    const inputs = ['a', 'b', 'c', 'd'].map(label => ({ label, required: false }));
    await expect(call(templateHandler, 'PUT', { inputs }).run()).rejects.toThrow();
    expect(h.saveOwnTemplate).not.toHaveBeenCalled();
  });

  it('PUT spends the submit rate limit only through the re-scan hook', async () => {
    h.saveOwnTemplate.mockResolvedValue({ id: 't' });
    const { run, res } = call(templateHandler, 'PUT', { headline: 'Hi' });
    await run();
    expect(h.enforceSubmit).not.toHaveBeenCalled();
    const deps = h.saveOwnTemplate.mock.calls[0][3] as { beforeScan: () => Promise<void> };
    await deps.beforeScan();
    expect(h.enforceSubmit).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toEqual({ template: { id: 't' } });
  });

  it('publish spends the submit rate limit before scanning; unpublish does not', async () => {
    h.publishOwnTemplate.mockResolvedValue({ id: 't', status: 'published' });
    await call(publishHandler, 'POST').run();
    expect(h.enforceSubmit).toHaveBeenCalledTimes(1);
    expect(h.enforceSubmit.mock.invocationCallOrder[0]).toBeLessThan(h.publishOwnTemplate.mock.invocationCallOrder[0]);

    h.unpublishOwnTemplate.mockResolvedValue({ id: 't', status: 'draft' });
    await call(publishHandler, 'DELETE').run();
    expect(h.enforceSubmit).toHaveBeenCalledTimes(1);
  });

  it('draft 404s for a missing listing without calling a model', async () => {
    h.approvedSnapshotForDraft.mockRejectedValueOnce(new NotFoundError('Listing not found'));
    await expect(call(draftHandler, 'POST').run()).rejects.toBeInstanceOf(NotFoundError);
    expect(h.getLlm).not.toHaveBeenCalled();
  });

  it('draft builds from the approved snapshot and names its version', async () => {
    const complete = vi.fn(async () =>
      JSON.stringify({ headline: 'Three bullets', inputs: [{ label: 'Article', required: true }], examplePrompt: 'Go' })
    );
    h.getLlm.mockResolvedValue({ model: 'm', complete });
    const { run, res } = call(draftHandler, 'POST');
    await run();
    expect(complete.mock.calls[0][1]).toContain('Summarize it.');
    expect(res._getJSONData()).toEqual({
      draft: { headline: 'Three bullets', inputs: [{ label: 'Article', required: true }], examplePrompt: 'Go' },
      generatedFromVersionId: 'version-1',
    });
  });

  it.each([
    ['the model wiring throws', () => h.getLlm.mockRejectedValue(new Error('no model'))],
    [
      'the model call throws',
      () => h.getLlm.mockResolvedValue({ model: 'm', complete: async () => Promise.reject(new Error('x')) }),
    ],
  ])('draft answers 200 with an empty draft when %s', async (_label, arrange) => {
    arrange();
    const { run, res } = call(draftHandler, 'POST');
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      draft: { headline: '', inputs: [], examplePrompt: '' },
      generatedFromVersionId: 'version-1',
    });
  });
});
